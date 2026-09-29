/* 看板客户端的测试。
 *
 * 最后一组是真的端到端：起一个求职看板的 Python 服务器，
 * 让扩展的客户端去打它。看板项目不在旁边就自动跳过。
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const desk = require("../shared/desk-client.js");

// 用一个假的 chrome.storage.local，好让 getBase/setBase 能跑
function stubChromeStorage(initial) {
  const store = Object.assign({}, initial || {});
  globalThis.chrome = {
    storage: {
      local: {
        async get(key) {
          if (typeof key === "string") return { [key]: store[key] };
          return Object.assign({}, store);
        },
        async set(patch) {
          Object.assign(store, patch);
        },
      },
    },
  };
  return store;
}

test.afterEach(() => {
  delete globalThis.chrome;
});

test("isLocalBase 只认本机", () => {
  const ok = [
    "http://127.0.0.1:8765",
    "http://localhost:9000",
    "https://127.0.0.1:8765",
  ];
  const bad = [
    "http://192.168.1.10:8765",
    "http://example.com",
    "https://evil.com/api",
    "ftp://127.0.0.1",
    "不是链接",
  ];
  ok.forEach((url) => assert.equal(desk.isLocalBase(url), true, url));
  bad.forEach((url) => assert.equal(desk.isLocalBase(url), false, url));
});

test("normalizeBase 补协议、去尾斜杠", () => {
  assert.equal(desk.normalizeBase("127.0.0.1:9000"), "http://127.0.0.1:9000");
  assert.equal(desk.normalizeBase("http://127.0.0.1:9000/"), "http://127.0.0.1:9000");
  assert.equal(desk.normalizeBase("  http://localhost:8765  "), "http://localhost:8765");
});

test("normalizeBase 对非本机地址一律退回默认值——看板里是你全部的求职记录", () => {
  assert.equal(desk.normalizeBase("http://evil.com"), desk.DEFAULT_BASE);
  assert.equal(desk.normalizeBase(""), desk.DEFAULT_BASE);
  assert.equal(desk.normalizeBase(null), desk.DEFAULT_BASE);
});

test("explainError 把连不上翻译成人话", () => {
  const message = desk.explainError(new Error("Failed to fetch"), "http://127.0.0.1:8765");
  assert.match(message, /python3 run\.py/);
  const timeout = desk.explainError(new Error("The operation was aborted"), "http://127.0.0.1:8765");
  assert.match(timeout, /没有响应/);
});

test("setBase 拒绝外部地址并落回默认值", async () => {
  stubChromeStorage();
  assert.equal(await desk.setBase("http://evil.com"), desk.DEFAULT_BASE);
  assert.equal(await desk.setBase("http://127.0.0.1:9999"), "http://127.0.0.1:9999");
  assert.equal(await desk.getBase(), "http://127.0.0.1:9999");
});

test("没配过地址时用默认的 8765", async () => {
  stubChromeStorage();
  assert.equal(await desk.getBase(), desk.DEFAULT_BASE);
});

test("看板没开时报错说得清楚，不是一句 fetch failed", async () => {
  stubChromeStorage({ deskBaseUrl: "http://127.0.0.1:1" });
  await assert.rejects(() => desk.ping(), (error) => {
    assert.match(error.message, /看板|run\.py/);
    return true;
  });
});

// ---------------------------------------------------------------- 端到端

function findDeskProject() {
  const candidates = [
    path.join(__dirname, "../../jobhunt-desk"),
    path.join(__dirname, "../jobhunt-desk"),
  ];
  return candidates.find((dir) => fs.existsSync(path.join(dir, "run.py")));
}

async function waitFor(check, timeoutMs = 12000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      if (await check()) return true;
    } catch (error) {
      // 还没起来，继续等
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

test("端到端：扩展存岗位 → 看板收到 → 回写已投", async (t) => {
  const project = findDeskProject();
  if (!project) {
    t.skip("旁边没有 jobhunt-desk 项目，跳过端到端");
    return;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "desk-e2e-"));
  const port = 18700 + Math.floor(Math.random() * 300);
  const child = spawn(
    "python3",
    ["run.py", "--no-browser", "--port", String(port), "--db", path.join(tmp, "e2e.db")],
    { cwd: project, stdio: "ignore" }
  );

  const base = `http://127.0.0.1:${port}`;
  stubChromeStorage({ deskBaseUrl: base });

  try {
    const up = await waitFor(async () => {
      const res = await fetch(base + "/api/overview");
      return res.ok;
    });
    if (!up) {
      t.skip("看板服务器没起来（可能没装 python3），跳过端到端");
      return;
    }

    const before = await desk.ping();
    assert.equal(before.total, 0);

    const job = {
      company: "汇添富基金",
      title: "产品岗（校招）",
      city: "上海",
      url: "https://htffund.zhiye.com/Campus/Position/12345",
      jd: "岗位职责：新产品设计与申报",
      source: "extension",
    };

    const saved = await desk.capture(job);
    assert.equal(saved.created, true);
    assert.equal(saved.job.ats, "beisen");
    assert.equal(saved.job.status, "想投");

    // 带上追踪参数再存一次，不该变成第二条
    const again = await desk.capture(Object.assign({}, job, { url: job.url + "?src=wx" }));
    assert.equal(again.created, false);
    assert.equal(again.id, saved.id);

    const found = await desk.lookup(job.url);
    assert.equal(found.job.company, "汇添富基金");

    const submitted = await desk.markSubmitted({ url: job.url });
    assert.equal(submitted.job.status, "已网申");
    assert.ok(submitted.job.applied_at, "应该自动记下投递日期");

    const after = await desk.ping();
    assert.equal(after.total, 1);
    assert.equal(after.submitted, 1);
  } finally {
    child.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("端到端：存一个没见过的岗位，看板会拒绝空得没法用的数据", async (t) => {
  const project = findDeskProject();
  if (!project) {
    t.skip("旁边没有 jobhunt-desk 项目，跳过");
    return;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "desk-e2e2-"));
  const port = 19100 + Math.floor(Math.random() * 300);
  const child = spawn(
    "python3",
    ["run.py", "--no-browser", "--port", String(port), "--db", path.join(tmp, "e2e.db")],
    { cwd: project, stdio: "ignore" }
  );
  stubChromeStorage({ deskBaseUrl: `http://127.0.0.1:${port}` });

  try {
    const up = await waitFor(async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/overview`);
      return res.ok;
    });
    if (!up) {
      t.skip("看板服务器没起来，跳过");
      return;
    }

    await assert.rejects(() => desk.capture({ title: "只有岗位名" }));
    await assert.rejects(() => desk.markSubmitted({ url: "https://没存过.com/x" }));
  } finally {
    child.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
