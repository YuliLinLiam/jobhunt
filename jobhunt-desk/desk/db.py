"""SQLite 层：建表、迁移、以及所有读写函数。

只依赖标准库。数据库文件默认在 data/jobs.db。
"""

import json
import os
import sqlite3
import time
from datetime import date, datetime, timedelta

# ---------------------------------------------------------------- 常量

STATUSES = [
    "想投",
    "已网申",
    "测评中",
    "面试中",
    "终面",
    "Offer",
    "已挂",
    "已放弃",
]

# 进行中 = 已经投出去、还没有结果的
ACTIVE_STATUSES = ["已网申", "测评中", "面试中", "终面"]
# 已投出 = 至少网申过
SUBMITTED_STATUSES = ["已网申", "测评中", "面试中", "终面", "Offer", "已挂"]
# 进面 = 到了面试环节
INTERVIEW_STATUSES = ["面试中", "终面", "Offer"]
CLOSED_STATUSES = ["Offer", "已挂", "已放弃"]

SCHEMA_VERSION = 1

_SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    company         TEXT NOT NULL,
    title           TEXT NOT NULL,
    city            TEXT DEFAULT '',
    url             TEXT DEFAULT '',
    url_key         TEXT DEFAULT '',
    ats             TEXT DEFAULT '',
    source          TEXT DEFAULT 'manual',
    jd              TEXT DEFAULT '',
    channel         TEXT DEFAULT '',
    company_type    TEXT DEFAULT '',
    track           TEXT DEFAULT '',
    priority        TEXT DEFAULT '常规',
    status          TEXT NOT NULL DEFAULT '想投',
    deadline        TEXT DEFAULT '',
    applied_at      TEXT DEFAULT '',
    assess_at       TEXT DEFAULT '',
    interview_at    TEXT DEFAULT '',
    next_action     TEXT DEFAULT '',
    note            TEXT DEFAULT '',
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_url_key
    ON jobs(url_key) WHERE url_key != '';
CREATE INDEX IF NOT EXISTS idx_jobs_status   ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_deadline ON jobs(deadline);

CREATE TABLE IF NOT EXISTS events (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id    INTEGER NOT NULL,
    kind      TEXT NOT NULL,
    detail    TEXT DEFAULT '',
    at        TEXT NOT NULL,
    FOREIGN KEY(job_id) REFERENCES jobs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_events_job ON events(job_id);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""

# 写入时允许的字段（白名单，防止前端塞进奇怪的列）
WRITABLE = {
    "company", "title", "city", "url", "ats", "source", "jd", "channel",
    "company_type", "track", "priority", "status", "deadline", "applied_at",
    "assess_at", "interview_at", "next_action", "note",
}

REQUIRED_ON_CREATE = ("company", "title")


# ---------------------------------------------------------------- 连接


def default_db_path():
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(here, "data", "jobs.db")


def connect(path=None):
    path = path or default_db_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    conn = sqlite3.connect(path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


def init(conn):
    conn.executescript(_SCHEMA)
    cur = conn.execute("SELECT value FROM settings WHERE key = 'schema_version'")
    row = cur.fetchone()
    if row is None:
        conn.execute(
            "INSERT INTO settings(key, value) VALUES ('schema_version', ?)",
            (str(SCHEMA_VERSION),),
        )
    conn.commit()
    return conn


# ---------------------------------------------------------------- 工具


def now():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def today():
    return date.today().isoformat()


def normalize_url(url):
    """把 URL 归一成去掉 query/hash 的 key，用于去重。

    同一个岗位在不同来源上常常带不同的追踪参数，去掉之后才能识别成一条。
    """
    if not url:
        return ""
    u = str(url).strip()
    if not u:
        return ""
    for sep in ("#", "?"):
        idx = u.find(sep)
        if idx >= 0:
            u = u[:idx]
    u = u.rstrip("/")
    low = u.lower()
    if low.startswith("https://"):
        u = "https://" + u[8:]
    elif low.startswith("http://"):
        u = "https://" + u[7:]
    return u


def normalize_date(value):
    """把常见的日期写法统一成 YYYY-MM-DD；认不出来就原样返回去掉空白的串。"""
    if value is None:
        return ""
    s = str(value).strip()
    if not s:
        return ""
    s = s.replace("年", "-").replace("月", "-").replace("日", "")
    s = s.replace("/", "-").replace(".", "-")
    s = s.strip("-")
    parts = [p for p in s.split("-") if p != ""]
    if len(parts) >= 3:
        try:
            y, m, d = int(parts[0]), int(parts[1]), int(parts[2][:2])
            if y < 100:
                y += 2000
            return date(y, m, d).isoformat()
        except (ValueError, TypeError):
            return s
    if len(parts) == 2:
        try:
            y, m = int(parts[0]), int(parts[1])
            if y < 100:
                y += 2000
            return date(y, m, 1).isoformat()
        except (ValueError, TypeError):
            return s
    return s


def guess_ats(url):
    """从 URL 认出是哪套招聘系统，填表扩展按这个挑字段映射。"""
    u = (url or "").lower()
    if not u:
        return ""
    table = [
        ("zhiye.com", "beisen"),
        ("mokahr.com", "moka"),
        ("myworkdayjobs.com", "workday"),
        ("successfactors", "successfactors"),
        ("avature", "avature"),
        ("careers.tencent.com", "tencent"),
        ("jobs.bytedance.com", "bytedance"),
        ("talent.alibaba.com", "alibaba"),
        ("dayee.com", "dayee"),
        ("zhaopin.com", "zhaopin"),
        ("greenhouse.io", "greenhouse"),
        ("lever.co", "lever"),
        ("ashbyhq.com", "ashby"),
    ]
    for needle, name in table:
        if needle in u:
            return name
    return ""


def _clean(payload):
    """只保留白名单字段，顺手把日期和 URL 规整一下。"""
    out = {}
    for key, value in (payload or {}).items():
        if key not in WRITABLE:
            continue
        if value is None:
            continue
        if key in ("deadline", "applied_at", "assess_at", "interview_at"):
            out[key] = normalize_date(value)
        elif key == "status":
            s = str(value).strip()
            out[key] = s if s in STATUSES else "想投"
        else:
            out[key] = str(value).strip()
    return out


def row_to_dict(row):
    return {k: row[k] for k in row.keys()}


# ---------------------------------------------------------------- 写


def create_job(conn, payload, event="手工录入"):
    data = _clean(payload)
    for field in REQUIRED_ON_CREATE:
        if not data.get(field):
            raise ValueError("缺少必填字段：%s" % field)

    url = data.get("url", "")
    url_key = normalize_url(url)
    if url_key:
        cur = conn.execute("SELECT id FROM jobs WHERE url_key = ?", (url_key,))
        hit = cur.fetchone()
        if hit:
            # 已经有了就当成更新，不再建一条重复的
            update_job(conn, hit["id"], payload, event="重复录入，已合并")
            return hit["id"], False

    if not data.get("ats"):
        data["ats"] = guess_ats(url)
    data.setdefault("status", "想投")
    data["url_key"] = url_key
    data["created_at"] = now()
    data["updated_at"] = data["created_at"]

    cols = list(data.keys())
    sql = "INSERT INTO jobs (%s) VALUES (%s)" % (
        ", ".join(cols),
        ", ".join("?" for _ in cols),
    )
    cur = conn.execute(sql, [data[c] for c in cols])
    job_id = cur.lastrowid
    _log(conn, job_id, "created", event)
    conn.commit()
    return job_id, True


def update_job(conn, job_id, payload, event=None):
    data = _clean(payload)
    if not data:
        return get_job(conn, job_id)

    before = conn.execute(
        "SELECT status FROM jobs WHERE id = ?", (job_id,)
    ).fetchone()
    if before is None:
        raise KeyError("岗位不存在：%s" % job_id)

    if "url" in data:
        data["url_key"] = normalize_url(data["url"])
        if not data.get("ats"):
            guessed = guess_ats(data["url"])
            if guessed:
                data["ats"] = guessed

    # 状态流转时自动补时间戳，省得手填
    new_status = data.get("status")
    if new_status and new_status != before["status"]:
        stamp_map = {
            "已网申": "applied_at",
            "测评中": "assess_at",
            "面试中": "interview_at",
        }
        field = stamp_map.get(new_status)
        if field and not data.get(field):
            existing = conn.execute(
                "SELECT %s AS v FROM jobs WHERE id = ?" % field, (job_id,)
            ).fetchone()
            if not existing["v"]:
                data[field] = today()

    data["updated_at"] = now()
    sets = ", ".join("%s = ?" % c for c in data.keys())
    conn.execute(
        "UPDATE jobs SET %s WHERE id = ?" % sets,
        list(data.values()) + [job_id],
    )

    if new_status and new_status != before["status"]:
        _log(conn, job_id, "status", "%s → %s" % (before["status"], new_status))
    elif event:
        _log(conn, job_id, "update", event)
    conn.commit()
    return get_job(conn, job_id)


def delete_job(conn, job_id):
    conn.execute("DELETE FROM jobs WHERE id = ?", (job_id,))
    conn.commit()


def _log(conn, job_id, kind, detail=""):
    conn.execute(
        "INSERT INTO events (job_id, kind, detail, at) VALUES (?, ?, ?, ?)",
        (job_id, kind, detail or "", now()),
    )


# ---------------------------------------------------------------- 读


def get_job(conn, job_id):
    row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
    if row is None:
        return None
    job = row_to_dict(row)
    job["events"] = [
        row_to_dict(r)
        for r in conn.execute(
            "SELECT * FROM events WHERE job_id = ? ORDER BY id DESC", (job_id,)
        )
    ]
    return job


def find_by_url(conn, url):
    key = normalize_url(url)
    if not key:
        return None
    row = conn.execute("SELECT * FROM jobs WHERE url_key = ?", (key,)).fetchone()
    return row_to_dict(row) if row else None


def list_jobs(conn, status=None, q=None, track=None, has_deadline=None,
              order="deadline", limit=1000):
    sql = "SELECT * FROM jobs WHERE 1=1"
    args = []
    if status:
        if status == "进行中":
            marks = ", ".join("?" for _ in ACTIVE_STATUSES)
            sql += " AND status IN (%s)" % marks
            args.extend(ACTIVE_STATUSES)
        elif status == "已结束":
            marks = ", ".join("?" for _ in CLOSED_STATUSES)
            sql += " AND status IN (%s)" % marks
            args.extend(CLOSED_STATUSES)
        else:
            sql += " AND status = ?"
            args.append(status)
    if track:
        sql += " AND track = ?"
        args.append(track)
    if has_deadline:
        sql += " AND deadline != ''"
    if q:
        sql += " AND (company LIKE ? OR title LIKE ? OR city LIKE ? OR note LIKE ?)"
        like = "%%%s%%" % q
        args.extend([like, like, like, like])

    if order == "deadline":
        # 没有 DDL 的排在最后，其余按日期升序
        sql += " ORDER BY (deadline = '') ASC, deadline ASC, updated_at DESC"
    elif order == "created":
        sql += " ORDER BY created_at DESC"
    else:
        sql += " ORDER BY updated_at DESC"
    sql += " LIMIT ?"
    args.append(int(limit))

    return [row_to_dict(r) for r in conn.execute(sql, args)]


def _count(conn, sql, args=()):
    row = conn.execute(sql, args).fetchone()
    return row[0] if row else 0


def overview(conn, days=7):
    total = _count(conn, "SELECT COUNT(*) FROM jobs")
    marks = ", ".join("?" for _ in SUBMITTED_STATUSES)
    submitted = _count(
        conn, "SELECT COUNT(*) FROM jobs WHERE status IN (%s)" % marks,
        SUBMITTED_STATUSES,
    )
    marks_a = ", ".join("?" for _ in ACTIVE_STATUSES)
    active = _count(
        conn, "SELECT COUNT(*) FROM jobs WHERE status IN (%s)" % marks_a,
        ACTIVE_STATUSES,
    )
    todo = _count(conn, "SELECT COUNT(*) FROM jobs WHERE status = '想投'")

    horizon = (date.today() + timedelta(days=days)).isoformat()
    week = [
        row_to_dict(r)
        for r in conn.execute(
            "SELECT * FROM jobs WHERE status = '想投' AND deadline != ''"
            " AND deadline <= ? ORDER BY deadline ASC",
            (horizon,),
        )
    ]
    overdue = [j for j in week if j["deadline"] < today()]
    upcoming = [j for j in week if j["deadline"] >= today()]

    recent = [
        row_to_dict(r)
        for r in conn.execute(
            "SELECT * FROM jobs ORDER BY created_at DESC LIMIT 8"
        )
    ]

    by_status = {}
    for r in conn.execute("SELECT status, COUNT(*) AS n FROM jobs GROUP BY status"):
        by_status[r["status"]] = r["n"]

    return {
        "total": total,
        "submitted": submitted,
        "active": active,
        "todo": todo,
        "week_count": len(upcoming),
        "week": upcoming,
        "overdue": overdue,
        "recent": recent,
        "by_status": by_status,
        "today": today(),
    }


def funnel(conn):
    marks_s = ", ".join("?" for _ in SUBMITTED_STATUSES)
    marks_i = ", ".join("?" for _ in INTERVIEW_STATUSES)
    stages = [
        ("入库", _count(conn, "SELECT COUNT(*) FROM jobs")),
        ("已投", _count(
            conn, "SELECT COUNT(*) FROM jobs WHERE status IN (%s)" % marks_s,
            SUBMITTED_STATUSES)),
        ("进面", _count(
            conn, "SELECT COUNT(*) FROM jobs WHERE status IN (%s)" % marks_i,
            INTERVIEW_STATUSES)),
        ("终面", _count(
            conn, "SELECT COUNT(*) FROM jobs WHERE status IN ('终面', 'Offer')")),
        ("Offer", _count(conn, "SELECT COUNT(*) FROM jobs WHERE status = 'Offer'")),
    ]
    out = []
    prev = None
    for name, n in stages:
        rate = None if prev in (None, 0) else round(n * 100.0 / prev)
        out.append({"stage": name, "count": n, "rate": rate})
        prev = n
    return out


def calendar(conn, month=None):
    """返回某个月里所有带日期的事件，日历页用。"""
    month = month or date.today().strftime("%Y-%m")
    prefix = month + "-"
    items = []
    fields = [
        ("deadline", "网申截止"),
        ("assess_at", "测评"),
        ("interview_at", "面试"),
    ]
    for field, label in fields:
        for r in conn.execute(
            "SELECT * FROM jobs WHERE %s LIKE ?" % field, (prefix + "%",)
        ):
            job = row_to_dict(r)
            items.append({
                "date": job[field],
                "kind": label,
                "job_id": job["id"],
                "company": job["company"],
                "title": job["title"],
                "status": job["status"],
            })
    items.sort(key=lambda x: (x["date"], x["kind"]))
    return {"month": month, "items": items}


def due_soon(conn, days=1):
    """今天和未来 days 天内截止的「想投」岗位，邮件提醒用。"""
    end = (date.today() + timedelta(days=days)).isoformat()
    return [
        row_to_dict(r)
        for r in conn.execute(
            "SELECT * FROM jobs WHERE status = '想投' AND deadline != ''"
            " AND deadline >= ? AND deadline <= ? ORDER BY deadline ASC",
            (today(), end),
        )
    ]


def stats_tracks(conn):
    out = []
    for r in conn.execute(
        "SELECT COALESCE(NULLIF(track, ''), '未分类') AS track, COUNT(*) AS n"
        " FROM jobs GROUP BY track ORDER BY n DESC"
    ):
        out.append({"track": r["track"], "count": r["n"]})
    return out


# ---------------------------------------------------------------- 设置


def get_setting(conn, key, default=None):
    row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    if row is None:
        return default
    try:
        return json.loads(row["value"])
    except (ValueError, TypeError):
        return row["value"]


def set_setting(conn, key, value):
    conn.execute(
        "INSERT INTO settings(key, value) VALUES (?, ?)"
        " ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, json.dumps(value, ensure_ascii=False)),
    )
    conn.commit()
