"""HTTP 路由。返回 (状态码, 内容类型, 正文bytes)。

所有路由都是纯函数式的，方便测试直接调，不必起服务器。
"""

import json
import re
from urllib.parse import parse_qs, urlparse

from . import db, importer

JSON = "application/json; charset=utf-8"
CSV = "text/csv; charset=utf-8"


def _json(payload, code=200):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    return code, JSON, body


def _err(message, code=400):
    return _json({"ok": False, "error": message}, code)


def _ok(payload=None):
    out = {"ok": True}
    if payload:
        out.update(payload)
    return _json(out)


_JOB_ID_RE = re.compile(r"^/api/jobs/(\d+)$")


def handle(conn, method, path, query, body):
    """把一次请求分派到具体处理函数。

    method: "GET" / "POST" / "PATCH" / "DELETE"
    path:   不含 query 的路径
    query:  dict[str, list[str]]
    body:   请求体字符串（可能是空串）
    """
    try:
        return _dispatch(conn, method, path, query, body)
    except ValueError as exc:
        return _err(str(exc), 400)
    except KeyError as exc:
        return _err(str(exc).strip("'\""), 404)
    except Exception as exc:  # 真出了意外也别让服务器整个挂掉
        return _err("服务器内部错误：%s" % exc, 500)


def _one(query, key, default=None):
    values = query.get(key)
    if not values:
        return default
    return values[0]


def _body_json(body):
    if not body:
        return {}
    try:
        data = json.loads(body)
    except ValueError:
        raise ValueError("请求体不是合法 JSON")
    if not isinstance(data, dict):
        raise ValueError("请求体必须是一个 JSON 对象")
    return data


def _dispatch(conn, method, path, query, body):
    # ---------------- 概览与统计
    if path == "/api/overview" and method == "GET":
        return _json(db.overview(conn))

    if path == "/api/funnel" and method == "GET":
        return _json({"stages": db.funnel(conn)})

    if path == "/api/calendar" and method == "GET":
        return _json(db.calendar(conn, _one(query, "month")))

    if path == "/api/tracks" and method == "GET":
        return _json({"tracks": db.stats_tracks(conn)})

    if path == "/api/meta" and method == "GET":
        return _json({
            "statuses": db.STATUSES,
            "active": db.ACTIVE_STATUSES,
            "closed": db.CLOSED_STATUSES,
            "today": db.today(),
        })

    # ---------------- 岗位列表
    if path == "/api/jobs" and method == "GET":
        jobs = db.list_jobs(
            conn,
            status=_one(query, "status"),
            q=_one(query, "q"),
            track=_one(query, "track"),
            has_deadline=_one(query, "has_deadline") == "1",
            order=_one(query, "order", "deadline"),
            limit=int(_one(query, "limit", "1000")),
        )
        return _json({"jobs": jobs, "count": len(jobs)})

    if path == "/api/jobs" and method == "POST":
        data = _body_json(body)
        items = data.get("jobs")
        if isinstance(items, list):
            created = merged = 0
            for item in items:
                _, is_new = db.create_job(conn, item)
                created += 1 if is_new else 0
                merged += 0 if is_new else 1
            return _ok({"created": created, "merged": merged})
        job_id, is_new = db.create_job(conn, data)
        return _json({"ok": True, "id": job_id, "created": is_new,
                      "job": db.get_job(conn, job_id)}, 201 if is_new else 200)

    match = _JOB_ID_RE.match(path)
    if match:
        job_id = int(match.group(1))
        if method == "GET":
            job = db.get_job(conn, job_id)
            if job is None:
                return _err("岗位不存在", 404)
            return _json({"job": job})
        if method in ("PATCH", "POST"):
            job = db.update_job(conn, job_id, _body_json(body))
            return _ok({"job": job})
        if method == "DELETE":
            db.delete_job(conn, job_id)
            return _ok()
        return _err("不支持的方法", 405)

    # ---------------- 扩展用：一键存岗位
    if path == "/api/capture" and method == "POST":
        data = _body_json(body)
        if not data.get("company") and not data.get("url"):
            return _err("至少要有公司名或链接")
        data.setdefault("company", "待补全")
        data.setdefault("title", "待补全")
        data.setdefault("source", "extension")
        existing = db.find_by_url(conn, data.get("url", ""))
        job_id, is_new = db.create_job(conn, data, event="扩展一键存岗位")
        return _json({
            "ok": True,
            "id": job_id,
            "created": is_new,
            "existed": existing is not None,
            "job": db.get_job(conn, job_id),
        })

    # ---------------- 扩展用：按链接查一条（投完回写状态前先找到它）
    if path == "/api/lookup" and method == "GET":
        job = db.find_by_url(conn, _one(query, "url", ""))
        return _json({"job": job})

    # ---------------- 扩展用：标记已投
    if path == "/api/submitted" and method == "POST":
        data = _body_json(body)
        job = None
        if data.get("id"):
            job = db.get_job(conn, int(data["id"]))
        elif data.get("url"):
            job = db.find_by_url(conn, data["url"])
        if job is None:
            return _err("没找到对应岗位，先用一键存岗位把它存进来", 404)
        updated = db.update_job(
            conn, job["id"], {"status": "已网申"}, event="扩展回写：已提交"
        )
        return _ok({"job": updated})

    # ---------------- 批量录入
    if path == "/api/import/csv" and method == "POST":
        data = _body_json(body)
        text = data.get("text", "")
        if not text.strip():
            return _err("没有内容")
        return _ok(importer.import_csv(conn, text))

    if path == "/api/import/urls" and method == "POST":
        data = _body_json(body)
        return _ok(importer.import_urls(conn, data.get("text", "")))

    if path == "/api/export.csv" and method == "GET":
        return 200, CSV, importer.export_csv(conn).encode("utf-8")

    # ---------------- 设置
    if path == "/api/settings" and method == "GET":
        return _json({
            "remind": db.get_setting(conn, "remind", {}),
            "tracks": db.get_setting(conn, "tracks", []),
        })

    if path == "/api/settings" and method == "POST":
        data = _body_json(body)
        for key, value in data.items():
            db.set_setting(conn, key, value)
        return _ok()

    return _err("没有这个接口：%s %s" % (method, path), 404)


def parse_target(raw_path):
    parsed = urlparse(raw_path)
    return parsed.path, parse_qs(parsed.query)
