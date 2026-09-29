"""每日 DDL 邮件提醒。

用法：
    python3 -m desk.remind              # 按 config.json 发一封
    python3 -m desk.remind --dry-run    # 只打印，不发

配置放在项目根的 config.json（照 config.example.json 抄），
或者用环境变量 JOBHUNT_SMTP_* 覆盖。密码建议用邮箱的「授权码」，
不是登录密码。
"""

import argparse
import json
import os
import smtplib
import sys
from email.message import EmailMessage

from . import db

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG_PATH = os.path.join(ROOT, "config.json")


def load_config():
    cfg = {}
    if os.path.isfile(CONFIG_PATH):
        with open(CONFIG_PATH, "r", encoding="utf-8") as fh:
            try:
                cfg = json.load(fh)
            except ValueError as exc:
                raise SystemExit("config.json 不是合法 JSON：%s" % exc)
    smtp = cfg.get("smtp", {})
    env = os.environ
    return {
        "host": env.get("JOBHUNT_SMTP_HOST", smtp.get("host", "")),
        "port": int(env.get("JOBHUNT_SMTP_PORT", smtp.get("port", 465))),
        "user": env.get("JOBHUNT_SMTP_USER", smtp.get("user", "")),
        "password": env.get("JOBHUNT_SMTP_PASSWORD", smtp.get("password", "")),
        "to": env.get("JOBHUNT_SMTP_TO", smtp.get("to", "")) or
              env.get("JOBHUNT_SMTP_USER", smtp.get("user", "")),
        "ssl": bool(smtp.get("ssl", True)),
        "days": int(cfg.get("remind_days", 1)),
    }


def build_message(jobs, today):
    """返回 (标题, 纯文本正文)。没有要提醒的就返回 None。"""
    if not jobs:
        return None
    due_today = [j for j in jobs if j["deadline"] == today]
    lines = []
    if due_today:
        lines.append("今天截止 %d 个：" % len(due_today))
        for job in due_today:
            lines.append("  · %s %s%s" % (
                job["company"], job["title"],
                ("  " + job["url"]) if job["url"] else "",
            ))
        lines.append("")
    later = [j for j in jobs if j["deadline"] != today]
    if later:
        lines.append("接下来几天：")
        for job in later:
            lines.append("  · %s  %s %s%s" % (
                job["deadline"], job["company"], job["title"],
                ("  " + job["url"]) if job["url"] else "",
            ))
    subject = "网申提醒：今天 %d 个截止，共 %d 个待投" % (
        len(due_today), len(jobs)
    )
    return subject, "\n".join(lines)


def send(config, subject, text):
    if not config["host"] or not config["user"]:
        raise SystemExit(
            "还没配 SMTP。把 config.example.json 复制成 config.json 填一下，"
            "或者设 JOBHUNT_SMTP_HOST / USER / PASSWORD 环境变量。"
        )
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = config["user"]
    msg["To"] = config["to"]
    msg.set_content(text)

    if config["ssl"]:
        server = smtplib.SMTP_SSL(config["host"], config["port"], timeout=20)
    else:
        server = smtplib.SMTP(config["host"], config["port"], timeout=20)
        server.starttls()
    with server:
        server.login(config["user"], config["password"])
        server.send_message(msg)


def main(argv=None):
    parser = argparse.ArgumentParser(description="发一封 DDL 提醒邮件")
    parser.add_argument("--dry-run", action="store_true", help="只打印不发送")
    parser.add_argument("--days", type=int, default=None,
                        help="提前几天提醒，默认读 config.json")
    parser.add_argument("--db", default=None, help="数据库路径")
    args = parser.parse_args(argv)

    config = load_config()
    days = args.days if args.days is not None else config["days"]

    conn = db.init(db.connect(args.db))
    jobs = db.due_soon(conn, days=days)
    built = build_message(jobs, db.today())
    conn.close()

    if built is None:
        print("没有需要提醒的岗位。")
        return 0

    subject, text = built
    if args.dry_run:
        print(subject)
        print()
        print(text)
        return 0

    send(config, subject, text)
    print("已发送：%s" % subject)
    return 0


if __name__ == "__main__":
    sys.exit(main())
