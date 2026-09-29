"""求职工作台的测试。

    python3 -m unittest discover -s tests -v
或者
    python3 tests/test_desk.py

分两层：
  · 纯函数和数据库层直接调，快；
  · 最后一组真的起一个 HTTP 服务器，用 urllib 打一遍，
    确认「照 README 跑起来」这件事本身是成立的。
"""

import json
import os
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from datetime import date, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from desk import api, db, importer, remind, server  # noqa: E402


def iso(offset_days):
    return (date.today() + timedelta(days=offset_days)).isoformat()


class TempDB(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.tmp.name, "t.db")
        self.conn = db.init(db.connect(self.path))

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def add(self, **kwargs):
        payload = {"company": "某公司", "title": "某岗位"}
        payload.update(kwargs)
        job_id, created = db.create_job(self.conn, payload)
        return job_id, created


# ------------------------------------------------------------ 纯函数


class TestNormalize(unittest.TestCase):
    def test_url_strips_query_hash_and_trailing_slash(self):
        self.assertEqual(
            db.normalize_url("https://a.zhiye.com/Campus?utm=wx#top"),
            "https://a.zhiye.com/Campus",
        )
        self.assertEqual(
            db.normalize_url("https://a.zhiye.com/Campus/"),
            "https://a.zhiye.com/Campus",
        )

    def test_url_upgrades_http_so_the_same_job_dedupes(self):
        self.assertEqual(
            db.normalize_url("http://a.com/x"), db.normalize_url("https://a.com/x")
        )

    def test_empty_url_is_empty_key(self):
        self.assertEqual(db.normalize_url(""), "")
        self.assertEqual(db.normalize_url(None), "")

    def test_date_accepts_chinese_and_slashes(self):
        self.assertEqual(db.normalize_date("2026年10月9日"), "2026-10-09")
        self.assertEqual(db.normalize_date("2026/10/9"), "2026-10-09")
        self.assertEqual(db.normalize_date("2026.10.09"), "2026-10-09")
        self.assertEqual(db.normalize_date("2026-10-09"), "2026-10-09")

    def test_date_two_digit_year(self):
        self.assertEqual(db.normalize_date("26-10-09"), "2026-10-09")

    def test_date_year_month_only(self):
        self.assertEqual(db.normalize_date("2026-10"), "2026-10-01")

    def test_date_garbage_survives_unchanged(self):
        self.assertEqual(db.normalize_date("待定"), "待定")
        self.assertEqual(db.normalize_date(""), "")

    def test_guess_ats(self):
        cases = {
            "https://htffund.zhiye.com/Campus": "beisen",
            "https://app.mokahr.com/campus-recruitment/jsfund/1": "moka",
            "https://citi.wd5.myworkdayjobs.com/x": "workday",
            "https://careers.tencent.com/x": "tencent",
            "https://example.com/jobs": "",
        }
        for url, expected in cases.items():
            self.assertEqual(db.guess_ats(url), expected, url)


# ------------------------------------------------------------ 数据库


class TestJobs(TempDB):
    def test_create_requires_company_and_title(self):
        with self.assertRaises(ValueError):
            db.create_job(self.conn, {"company": "只有公司"})
        with self.assertRaises(ValueError):
            db.create_job(self.conn, {"title": "只有岗位"})

    def test_create_ignores_unknown_columns(self):
        job_id, _ = self.add(evil="DROP TABLE jobs", city="上海")
        job = db.get_job(self.conn, job_id)
        self.assertEqual(job["city"], "上海")
        self.assertNotIn("evil", job)

    def test_same_url_merges_instead_of_duplicating(self):
        first, created_a = self.add(url="https://a.com/job?utm=1")
        second, created_b = self.add(url="https://a.com/job#frag", city="深圳")
        self.assertTrue(created_a)
        self.assertFalse(created_b)
        self.assertEqual(first, second)
        self.assertEqual(db.get_job(self.conn, first)["city"], "深圳")

    def test_blank_urls_do_not_collide(self):
        a, _ = self.add(company="甲")
        b, _ = self.add(company="乙")
        self.assertNotEqual(a, b)

    def test_ats_is_guessed_on_create(self):
        job_id, _ = self.add(url="https://x.zhiye.com/Campus")
        self.assertEqual(db.get_job(self.conn, job_id)["ats"], "beisen")

    def test_status_falls_back_when_unknown(self):
        job_id, _ = self.add(status="乱写的状态")
        self.assertEqual(db.get_job(self.conn, job_id)["status"], "想投")

    def test_status_change_stamps_the_date_once(self):
        job_id, _ = self.add()
        db.update_job(self.conn, job_id, {"status": "已网申"})
        job = db.get_job(self.conn, job_id)
        self.assertEqual(job["applied_at"], db.today())

        # 再改回去又改回来，原来的投递日期不该被覆盖
        db.update_job(self.conn, job_id, {"status": "想投"})
        db.update_job(self.conn, job_id, {"status": "已网申"})
        self.assertEqual(db.get_job(self.conn, job_id)["applied_at"], db.today())

    def test_explicit_date_beats_auto_stamp(self):
        job_id, _ = self.add()
        db.update_job(self.conn, job_id, {"status": "已网申", "applied_at": "2026-01-02"})
        self.assertEqual(db.get_job(self.conn, job_id)["applied_at"], "2026-01-02")

    def test_status_change_writes_an_event(self):
        job_id, _ = self.add()
        db.update_job(self.conn, job_id, {"status": "面试中"})
        kinds = [e["kind"] for e in db.get_job(self.conn, job_id)["events"]]
        self.assertIn("status", kinds)
        detail = [e["detail"] for e in db.get_job(self.conn, job_id)["events"]
                  if e["kind"] == "status"][0]
        self.assertIn("→", detail)

    def test_update_missing_job_raises(self):
        with self.assertRaises(KeyError):
            db.update_job(self.conn, 9999, {"status": "已挂"})

    def test_delete_removes_events_too(self):
        job_id, _ = self.add()
        db.delete_job(self.conn, job_id)
        self.assertIsNone(db.get_job(self.conn, job_id))
        left = self.conn.execute(
            "SELECT COUNT(*) FROM events WHERE job_id = ?", (job_id,)
        ).fetchone()[0]
        self.assertEqual(left, 0)

    def test_find_by_url_ignores_tracking_params(self):
        self.add(url="https://a.com/x")
        self.assertIsNotNone(db.find_by_url(self.conn, "https://a.com/x?from=wechat"))
        self.assertIsNone(db.find_by_url(self.conn, "https://b.com/x"))


class TestListing(TempDB):
    def setUp(self):
        super().setUp()
        self.add(company="甲", deadline=iso(2), status="想投", track="公募")
        self.add(company="乙", deadline=iso(-3), status="想投", track="公募")
        self.add(company="丙", status="面试中", track="出海")
        self.add(company="丁", status="Offer")
        self.add(company="戊", status="已挂")

    def test_jobs_without_deadline_sort_last(self):
        jobs = db.list_jobs(self.conn)
        self.assertEqual(jobs[-1]["deadline"], "")

    def test_filter_by_single_status(self):
        self.assertEqual(len(db.list_jobs(self.conn, status="想投")), 2)

    def test_filter_active_group(self):
        names = [j["company"] for j in db.list_jobs(self.conn, status="进行中")]
        self.assertEqual(names, ["丙"])

    def test_filter_closed_group(self):
        names = sorted(j["company"] for j in db.list_jobs(self.conn, status="已结束"))
        self.assertEqual(names, ["丁", "戊"])

    def test_search_matches_company(self):
        self.assertEqual(len(db.list_jobs(self.conn, q="丙")), 1)

    def test_filter_by_track(self):
        self.assertEqual(len(db.list_jobs(self.conn, track="公募")), 2)

    def test_overview_counts(self):
        data = db.overview(self.conn)
        self.assertEqual(data["total"], 5)
        self.assertEqual(data["todo"], 2)
        self.assertEqual(data["active"], 1)
        self.assertEqual(data["submitted"], 3)   # 面试中 + Offer + 已挂

    def test_overview_separates_overdue_from_upcoming(self):
        data = db.overview(self.conn)
        self.assertEqual([j["company"] for j in data["week"]], ["甲"])
        self.assertEqual([j["company"] for j in data["overdue"]], ["乙"])

    def test_funnel_is_monotonically_non_increasing(self):
        counts = [s["count"] for s in db.funnel(self.conn)]
        self.assertEqual(counts, sorted(counts, reverse=True))

    def test_calendar_picks_up_deadlines(self):
        month = iso(2)[:7]
        items = db.calendar(self.conn, month)["items"]
        self.assertTrue(any(i["company"] == "甲" for i in items))

    def test_due_soon_excludes_already_applied(self):
        job_id, _ = self.add(company="己", deadline=iso(0))
        self.assertIn("己", [j["company"] for j in db.due_soon(self.conn, days=1)])
        db.update_job(self.conn, job_id, {"status": "已网申"})
        self.assertNotIn("己", [j["company"] for j in db.due_soon(self.conn, days=1)])


# ------------------------------------------------------------ 导入导出


class TestImporter(TempDB):
    def test_chinese_headers(self):
        rows, problems = importer.parse_csv(
            "公司,岗位,城市\n汇添富,产品岗,上海\n"
        )
        self.assertEqual(problems, [])
        self.assertEqual(rows[0]["company"], "汇添富")
        self.assertEqual(rows[0]["city"], "上海")

    def test_english_headers(self):
        rows, _ = importer.parse_csv("company,title\nAcme,PM\n")
        self.assertEqual(rows[0]["title"], "PM")

    def test_tab_separated_from_a_spreadsheet_paste(self):
        rows, _ = importer.parse_csv("公司\t岗位\t城市\n嘉实\t风控\t上海\n")
        self.assertEqual(rows[0]["company"], "嘉实")

    def test_missing_required_header_is_reported_not_raised(self):
        rows, problems = importer.parse_csv("城市,备注\n上海,x\n")
        self.assertEqual(rows, [])
        self.assertTrue(problems)

    def test_unknown_columns_are_reported_but_do_not_block(self):
        rows, problems = importer.parse_csv("公司,岗位,星座\n甲,乙,天秤\n")
        self.assertEqual(len(rows), 1)
        self.assertTrue(any("星座" in p for p in problems))

    def test_bad_row_is_skipped_and_the_rest_still_import(self):
        result = importer.import_csv(
            self.conn, "公司,岗位\n甲,岗位一\n,缺公司\n乙,岗位二\n"
        )
        self.assertEqual(result["created"], 2)
        self.assertTrue(result["problems"])

    def test_bom_is_stripped(self):
        rows, problems = importer.parse_csv("﻿公司,岗位\n甲,乙\n")
        self.assertEqual(problems, [])
        self.assertEqual(len(rows), 1)

    def test_sample_file_imports_cleanly(self):
        here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        with open(os.path.join(here, "sample", "sample-jobs.csv"), encoding="utf-8") as fh:
            result = importer.import_csv(self.conn, fh.read())
        self.assertEqual(result["created"], 7)
        self.assertEqual(result["problems"], [])

    def test_urls_are_extracted_from_prose(self):
        rows = importer.parse_urls(
            "看这个 https://htffund.zhiye.com/Campus ，还有"
            " https://app.mokahr.com/campus-recruitment/jsfund/43906 。"
        )
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["company"], "htffund")
        self.assertEqual(rows[0]["ats"], "beisen")
        self.assertEqual(rows[1]["company"], "jsfund")

    def test_duplicate_urls_collapse(self):
        rows = importer.parse_urls("https://a.com/x\nhttps://a.com/x?utm=1\n")
        self.assertEqual(len(rows), 1)

    def test_export_has_bom_and_every_row(self):
        self.add(company="甲")
        self.add(company="乙")
        text = importer.export_csv(self.conn)
        self.assertTrue(text.startswith("﻿"))
        self.assertIn("甲", text)
        self.assertIn("乙", text)


# ------------------------------------------------------------ 提醒


class TestRemind(TempDB):
    def test_no_jobs_means_no_email(self):
        self.assertIsNone(remind.build_message([], db.today()))

    def test_message_splits_today_and_later(self):
        self.add(company="今天的", deadline=iso(0))
        self.add(company="后天的", deadline=iso(2))
        jobs = db.due_soon(self.conn, days=3)
        subject, text = remind.build_message(jobs, db.today())
        self.assertIn("今天 1 个截止", subject)
        self.assertIn("今天的", text)
        self.assertIn("后天的", text)
        self.assertLess(text.index("今天的"), text.index("后天的"))


# ------------------------------------------------------------ API（纯函数层）


class TestApi(TempDB):
    def call(self, method, path, body=None):
        target, query = api.parse_target(path)
        code, ctype, raw = api.handle(
            self.conn, method, target, query,
            json.dumps(body) if body is not None else "",
        )
        if "json" in ctype:
            return code, json.loads(raw.decode("utf-8"))
        return code, raw.decode("utf-8")

    def test_unknown_route_404s_without_crashing(self):
        code, data = self.call("GET", "/api/nope")
        self.assertEqual(code, 404)
        self.assertFalse(data["ok"])

    def test_bad_json_is_a_400_not_a_500(self):
        target, query = api.parse_target("/api/jobs")
        code, _, raw = api.handle(self.conn, "POST", target, query, "{not json")
        self.assertEqual(code, 400)
        self.assertIn("JSON", json.loads(raw.decode("utf-8"))["error"])

    def test_create_then_read_then_patch_then_delete(self):
        code, data = self.call("POST", "/api/jobs",
                               {"company": "甲", "title": "乙", "city": "上海"})
        self.assertEqual(code, 201)
        job_id = data["id"]

        code, data = self.call("GET", "/api/jobs/%d" % job_id)
        self.assertEqual(data["job"]["city"], "上海")

        code, data = self.call("PATCH", "/api/jobs/%d" % job_id, {"status": "已网申"})
        self.assertEqual(data["job"]["status"], "已网申")

        code, _ = self.call("DELETE", "/api/jobs/%d" % job_id)
        self.assertEqual(code, 200)
        code, _ = self.call("GET", "/api/jobs/%d" % job_id)
        self.assertEqual(code, 404)

    def test_batch_create(self):
        code, data = self.call("POST", "/api/jobs", {"jobs": [
            {"company": "甲", "title": "a"},
            {"company": "乙", "title": "b"},
        ]})
        self.assertEqual(data["created"], 2)

    def test_capture_from_extension_then_lookup_then_submitted(self):
        url = "https://htffund.zhiye.com/Campus/job/77"
        code, data = self.call("POST", "/api/capture", {
            "company": "汇添富", "title": "产品岗", "url": url, "jd": "岗位描述…",
        })
        self.assertTrue(data["created"])
        self.assertEqual(data["job"]["ats"], "beisen")

        # 同一个岗位带着追踪参数再来一次，不该变成第二条
        code, again = self.call("POST", "/api/capture", {
            "company": "汇添富", "title": "产品岗", "url": url + "?src=wx",
        })
        self.assertFalse(again["created"])
        self.assertEqual(again["id"], data["id"])

        code, found = self.call("GET", "/api/lookup?url=" + url)
        self.assertEqual(found["job"]["id"], data["id"])

        code, done = self.call("POST", "/api/submitted", {"url": url})
        self.assertEqual(done["job"]["status"], "已网申")
        self.assertEqual(done["job"]["applied_at"], db.today())

    def test_capture_without_company_or_url_is_rejected(self):
        code, data = self.call("POST", "/api/capture", {"title": "只有岗位名"})
        self.assertEqual(code, 400)

    def test_submitted_for_unknown_url_404s(self):
        code, data = self.call("POST", "/api/submitted", {"url": "https://nope.com/x"})
        self.assertEqual(code, 404)

    def test_import_csv_route(self):
        code, data = self.call("POST", "/api/import/csv",
                               {"text": "公司,岗位\n甲,乙\n"})
        self.assertEqual(data["created"], 1)

    def test_export_route_returns_csv(self):
        self.call("POST", "/api/jobs", {"company": "甲", "title": "乙"})
        code, text = self.call("GET", "/api/export.csv")
        self.assertEqual(code, 200)
        self.assertIn("甲", text)

    def test_settings_round_trip(self):
        self.call("POST", "/api/settings", {"tracks": ["公募", "出海"]})
        code, data = self.call("GET", "/api/settings")
        self.assertEqual(data["tracks"], ["公募", "出海"])


# ------------------------------------------------------------ 真起一个服务器


class TestLiveServer(unittest.TestCase):
    """确认 `python3 run.py` 这条路本身是通的。"""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.conn = db.init(db.connect(os.path.join(cls.tmp.name, "live.db")))
        cls.port = server.pick_port(18765)
        cls.httpd = server.make_server(cls.conn, cls.port)
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = "http://127.0.0.1:%d" % cls.port

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.conn.close()
        cls.tmp.cleanup()

    def fetch(self, path, method="GET", payload=None):
        data = json.dumps(payload).encode("utf-8") if payload is not None else None
        req = urllib.request.Request(
            self.base + path, data=data, method=method,
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=5) as res:
                return res.status, res.read().decode("utf-8"), dict(res.headers)
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read().decode("utf-8"), dict(exc.headers)

    def test_index_page_is_served(self):
        status, body, headers = self.fetch("/")
        self.assertEqual(status, 200)
        self.assertIn("求职工作台", body)
        self.assertIn("text/html", headers["Content-Type"])

    def test_static_assets_are_served(self):
        for path, needle in [("/app.js", "function esc"), ("/style.css", "--sidebar")]:
            status, body, _ = self.fetch(path)
            self.assertEqual(status, 200, path)
            self.assertIn(needle, body)

    def test_directory_traversal_is_blocked(self):
        status, _, _ = self.fetch("/../desk/db.py")
        self.assertIn(status, (403, 404))

    def test_cors_headers_let_the_extension_post(self):
        _, _, headers = self.fetch("/api/overview")
        self.assertEqual(headers.get("Access-Control-Allow-Origin"), "*")

    def test_full_round_trip_over_http(self):
        status, body, _ = self.fetch(
            "/api/capture", "POST",
            {"company": "实时公司", "title": "实时岗位",
             "url": "https://live.example.com/job/1"},
        )
        self.assertEqual(status, 200)
        job_id = json.loads(body)["id"]

        status, body, _ = self.fetch("/api/jobs")
        self.assertIn("实时公司", body)

        status, body, _ = self.fetch("/api/jobs/%d" % job_id, "PATCH",
                                     {"status": "面试中"})
        self.assertEqual(json.loads(body)["job"]["status"], "面试中")

        status, body, _ = self.fetch("/api/overview")
        self.assertEqual(json.loads(body)["active"], 1)

    def test_write_to_non_api_path_is_refused(self):
        status, _, _ = self.fetch("/index.html", "POST", {})
        self.assertEqual(status, 404)


if __name__ == "__main__":
    unittest.main(verbosity=2)
