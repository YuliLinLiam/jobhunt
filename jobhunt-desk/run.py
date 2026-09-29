#!/usr/bin/env python3
"""启动求职工作台。

    python3 run.py                  # 起服务并打开浏览器
    python3 run.py --port 9000      # 换端口
    python3 run.py --no-browser     # 不自动开浏览器
    python3 run.py --db /path/x.db  # 换数据库文件

只用 Python 标准库，不需要 pip install 任何东西。
"""

import argparse
import sys

if sys.version_info < (3, 8):
    raise SystemExit("需要 Python 3.8 以上，当前是 %s" % sys.version.split()[0])

from desk import server


def main():
    parser = argparse.ArgumentParser(description="求职工作台")
    parser.add_argument("--port", type=int, default=8765, help="端口，被占用会自动顺延")
    parser.add_argument("--db", default=None, help="数据库文件路径")
    parser.add_argument("--no-browser", action="store_true", help="不自动打开浏览器")
    args = parser.parse_args()
    server.serve(db_path=args.db, port=args.port, open_browser=not args.no_browser)


if __name__ == "__main__":
    main()
