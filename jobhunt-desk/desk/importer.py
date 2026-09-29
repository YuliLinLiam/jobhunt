"""批量录入：CSV 导入 和 粘一批链接。"""

import csv
import io
import re
from urllib.parse import urlparse

from . import db

# CSV 表头的中英文都认，多写几个别名省得每次改表头
HEADER_ALIASES = {
    "company": ["company", "公司", "公司名称", "企业", "机构"],
    "title": ["title", "岗位", "职位", "岗位名称", "职位名称"],
    "city": ["city", "城市", "地点", "工作地点", "base"],
    "url": ["url", "链接", "投递链接", "网申链接", "岗位链接"],
    "deadline": ["deadline", "ddl", "截止", "截止日期", "网申ddl", "网申截止"],
    "status": ["status", "状态", "当前状态"],
    "channel": ["channel", "渠道", "投递渠道"],
    "company_type": ["company_type", "公司类型", "企业类型"],
    "track": ["track", "赛道", "方向", "岗位类型"],
    "priority": ["priority", "心仪程度", "优先级"],
    "applied_at": ["applied_at", "投递日期", "网申日期"],
    "assess_at": ["assess_at", "测评时间"],
    "interview_at": ["interview_at", "面试时间"],
    "next_action": ["next_action", "下一步", "下一步动作"],
    "note": ["note", "备注", "说明", "信息来源"],
    "jd": ["jd", "岗位描述", "职位描述"],
}

_LOOKUP = {}
for _canon, _names in HEADER_ALIASES.items():
    for _n in _names:
        _LOOKUP[_n.strip().lower().replace(" ", "")] = _canon


def _canonical(header):
    key = (header or "").strip().lower().replace(" ", "").replace("　", "")
    return _LOOKUP.get(key)


def _sniff(text):
    """CSV 还是制表符分隔？两种都常见（从表格里直接复制出来的是 Tab）。"""
    first = text.split("\n", 1)[0]
    if first.count("\t") > first.count(","):
        return "\t"
    return ","


def parse_csv(text):
    """把 CSV/TSV 文本解析成可以写库的 dict 列表。

    返回 (rows, problems)。problems 是每一行的问题说明，不抛异常，
    因为导入时最不想看到的就是「第 37 行有问题，整批都不进」。
    """
    text = (text or "").lstrip("﻿")
    if not text.strip():
        return [], ["内容是空的"]

    delim = _sniff(text)
    reader = csv.reader(io.StringIO(text), delimiter=delim)
    try:
        header = next(reader)
    except StopIteration:
        return [], ["内容是空的"]

    mapping = {}
    unknown = []
    for idx, name in enumerate(header):
        canon = _canonical(name)
        if canon:
            mapping[idx] = canon
        elif name.strip():
            unknown.append(name.strip())

    problems = []
    if "company" not in mapping.values() or "title" not in mapping.values():
        problems.append(
            "表头里至少要有「公司」和「岗位」两列（也接受 company / title）"
        )
        return [], problems
    if unknown:
        problems.append("以下列没认出来，已跳过：" + "、".join(unknown))

    rows = []
    for line_no, raw in enumerate(reader, start=2):
        if not any((c or "").strip() for c in raw):
            continue
        item = {}
        for idx, value in enumerate(raw):
            canon = mapping.get(idx)
            if canon and (value or "").strip():
                item[canon] = value.strip()
        if not item.get("company") or not item.get("title"):
            problems.append("第 %d 行缺公司或岗位，已跳过" % line_no)
            continue
        item.setdefault("source", "csv")
        rows.append(item)
    return rows, problems


def import_csv(conn, text):
    rows, problems = parse_csv(text)
    created = 0
    merged = 0
    for row in rows:
        try:
            _, is_new = db.create_job(conn, row, event="CSV 导入")
            if is_new:
                created += 1
            else:
                merged += 1
        except ValueError as exc:
            problems.append(str(exc))
    return {
        "created": created,
        "merged": merged,
        "parsed": len(rows),
        "problems": problems,
    }


# ---------------------------------------------------------------- 粘链接

_URL_RE = re.compile(r"https?://[^\s<>\"'）)】\]]+")

# 从域名猜公司名，猜不准也没关系，进来之后能改
_DOMAIN_HINTS = {
    "zhiye.com": None,       # 北森：二级域名就是公司代号
    "mokahr.com": None,
}


def _company_from_url(url):
    try:
        host = urlparse(url).hostname or ""
    except (ValueError, AttributeError):
        return ""
    host = host.lower()
    if host.endswith(".zhiye.com"):
        return host[: -len(".zhiye.com")]
    if "mokahr.com" in host:
        # app.mokahr.com/campus-recruitment/<租户>/<批次>
        parts = [p for p in urlparse(url).path.split("/") if p]
        if len(parts) >= 2:
            return parts[1]
        return ""
    parts = [p for p in host.split(".") if p not in ("www", "com", "cn", "net", "org")]
    return parts[0] if parts else ""


def parse_urls(text):
    """从一坨文本里抠出所有链接，每条给一个待补全的岗位骨架。"""
    seen = set()
    out = []
    for match in _URL_RE.finditer(text or ""):
        url = match.group(0).rstrip(".,;；，。")
        key = db.normalize_url(url)
        if not key or key in seen:
            continue
        seen.add(key)
        out.append({
            "company": _company_from_url(url) or "待补全",
            "title": "待补全",
            "url": url,
            "ats": db.guess_ats(url),
            "source": "url",
            "status": "想投",
        })
    return out


def import_urls(conn, text):
    rows = parse_urls(text)
    created = 0
    merged = 0
    for row in rows:
        _, is_new = db.create_job(conn, row, event="粘链接批量建")
        if is_new:
            created += 1
        else:
            merged += 1
    return {
        "created": created,
        "merged": merged,
        "parsed": len(rows),
        "problems": [] if rows else ["没有在文本里找到链接"],
    }


# ---------------------------------------------------------------- 导出

EXPORT_COLUMNS = [
    ("id", "ID"),
    ("company", "公司"),
    ("title", "岗位"),
    ("city", "城市"),
    ("track", "赛道"),
    ("company_type", "公司类型"),
    ("priority", "心仪程度"),
    ("status", "状态"),
    ("deadline", "网申截止"),
    ("applied_at", "投递日期"),
    ("assess_at", "测评时间"),
    ("interview_at", "面试时间"),
    ("channel", "渠道"),
    ("next_action", "下一步"),
    ("url", "投递链接"),
    ("note", "备注"),
]


def export_csv(conn):
    buf = io.StringIO()
    buf.write("﻿")  # BOM，Excel 打开才不乱码
    writer = csv.writer(buf)
    writer.writerow([label for _, label in EXPORT_COLUMNS])
    for job in db.list_jobs(conn, order="created", limit=100000):
        writer.writerow([job.get(key, "") for key, _ in EXPORT_COLUMNS])
    return buf.getvalue()
