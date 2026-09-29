# 求职工作台 · Jobhunt Desk

一块屏看清全局：哪些岗位还没投、这周哪些 DDL、投了多少、卡在哪一轮。

全部跑在你自己的电脑上。**零依赖**——只用 Python 标准库，不需要 `pip install` 任何东西，不联网，不上传。

---

## 跑起来

```bash
cd jobhunt-desk
python3 run.py
```

浏览器会自动打开 `http://127.0.0.1:8765`。端口被占用会自动往后顺延。

需要 Python 3.8 以上（macOS 和大多数 Linux 自带；Windows 从 python.org 装一个）。

常用参数：

```bash
python3 run.py --port 9000      # 换端口
python3 run.py --no-browser     # 不自动开浏览器
python3 run.py --db ~/x.db      # 换数据库文件
```

数据库默认在 `data/jobs.db`。这个文件就是你的全部数据，拷走就是备份。

---

## 五个页面

| 页面 | 干什么 |
| --- | --- |
| 今日总览 | 四个指标 + 七天内截止 + 已过期还没处理的 + 最近录入 |
| 岗位清单 | 全部岗位，按状态筛、按关键词搜，点一行开详情抽屉 |
| 投递台账 | 看板形态，拖卡片就是改状态 |
| DDL 日历 | 月视图，网申截止 / 测评 / 面试三种事件分色 |
| 漏斗 | 入库 → 已投 → 进面 → 终面 → Offer，每层留存率；另按赛道统计 |

状态一共八个：想投、已网申、测评中、面试中、终面、Offer、已挂、已放弃。
改成「已网申」「测评中」「面试中」时会自动记下当天日期，不用手填。

---

## 三种录入方式

进「录入岗位」页面：

1. **手工加一条** —— 只有公司和岗位是必填。
2. **粘一批链接** —— 一行一个，或者整段文字里带链接也行。公司名会按域名猜（北森的二级域名、Moka 的租户名），进来之后能改。
3. **CSV / 从表格里复制** —— 第一行是表头，逗号或 Tab 分隔都认。

CSV 表头认中英文两套写法：

| 字段 | 中文表头 | 英文表头 |
| --- | --- | --- |
| 必填 | 公司、岗位 | company、title |
| 可选 | 城市、投递链接、网申截止、状态、赛道、公司类型、心仪程度、投递渠道、投递日期、测评时间、面试时间、下一步、备注 | city、url、deadline、status、track、company_type、priority、channel、applied_at、assess_at、interview_at、next_action、note |

认不出来的列会跳过并在提示里说明，某一行有问题只跳过那一行，不会整批失败。

`sample/sample-jobs.csv` 是一份可以直接导入的样例。

**去重**：按投递链接去重，去掉 query 和 hash 再比。所以同一个岗位带着不同的追踪参数从几个地方录进来，只会是一条。

---

## 每天的 DDL 邮件提醒

不依赖看板开着，手机上也收得到。

1. 把 `config.example.json` 复制成 `config.json`，填上 SMTP。**密码用邮箱的「授权码」，不是登录密码**（QQ 邮箱、163 邮箱都在设置里发授权码）。
2. 先干跑一次看内容对不对：

```bash
python3 -m desk.remind --dry-run
```

3. 挂到系统定时任务里。macOS / Linux：

```bash
crontab -e
# 每天早上 8 点
0 8 * * * cd /你的路径/jobhunt-desk && /usr/bin/python3 -m desk.remind
```

Windows 用「任务计划程序」，操作填 `python.exe`，参数填 `-m desk.remind`，起始位置填项目目录。

也可以不写 config.json，改用环境变量：`JOBHUNT_SMTP_HOST` / `PORT` / `USER` / `PASSWORD` / `TO`。

---

## 给填表扩展用的接口

服务器只绑 `127.0.0.1`，外网访问不到；但开了 CORS，所以 Edge 扩展能从任意网页的上下文往这里发请求。

| 接口 | 干什么 |
| --- | --- |
| `POST /api/capture` | 一键存岗位。传 `{company, title, city, url, jd}`，按 URL 去重，返回岗位 id |
| `GET /api/lookup?url=` | 按链接查一条，用来判断「这个岗位存过没有」 |
| `POST /api/submitted` | 传 `{url}` 或 `{id}`，把状态改成「已网申」并记下日期 |
| `GET /api/jobs` | 列表，支持 `status` / `q` / `track` / `order` / `limit` |
| `POST /api/jobs` | 新建一条或一批（`{jobs: [...]}`） |
| `PATCH /api/jobs/{id}` | 改任意字段 |
| `GET /api/overview` `/api/funnel` `/api/calendar` | 三个统计接口 |
| `GET /api/export.csv` | 导出全部岗位 |

---

## 测试

```bash
python3 tests/test_desk.py
```

60 个用例，最后一组会真的起一个 HTTP 服务器用 urllib 打一遍，确认「照这份 README 跑起来」这件事本身是成立的。

---

## 目录

```
jobhunt-desk/
  run.py                启动入口
  desk/
    db.py               建表、迁移、全部读写
    api.py              HTTP 路由（纯函数，方便测）
    server.py           http.server 封装 + 静态文件 + CORS
    importer.py         CSV / 粘链接 / 导出
    remind.py           DDL 邮件提醒
  web/                  前端，原生 JS，没有构建步骤
  data/jobs.db          你的数据（跑起来之后生成）
  sample/               样例 CSV
  tests/                测试
```

---

## 几条设计上的取舍

- **不抓岗位。** 岗位由你自己找、自己录。这样既不涉及爬取的法律和风控问题，录进来的每一条也都是你真想投的。
- **不自动提交。** 看板只读数据库，不会向任何招聘网站发请求。
- **不存 HR 联系方式。** 只存公司、岗位、地点、链接、截止日期这些岗位信息。
- **一个文件装下全部数据。** 没有服务器、没有账号、没有云同步，`data/jobs.db` 拷走就能换电脑。
