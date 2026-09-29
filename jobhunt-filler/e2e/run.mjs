/* 浏览器里的端到端检查。
 *
 *   node e2e/run.mjs
 *
 * 做三件事：
 *   1. 把扩展真的当扩展加载进 Chromium，确认 manifest 和 service worker 没问题；
 *   2. 打开侧边栏页面，看有没有 JS 报错，顺便截图；
 *   3. 在一个仿真的网申页面上跑 content.js 的两个新动作
 *      （一键存岗位、必填项检查），确认它们在真 DOM 上是对的。
 *
 * 需要 playwright。没装就装一个：npm i -g playwright
 */

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

function loadPlaywright() {
  try {
    return require("playwright");
  } catch (error) {
    const globalRoot = execSync("npm root -g").toString().trim();
    return require(path.join(globalRoot, "playwright"));
  }
}

const { chromium } = loadPlaywright();

const CHROME_PATHS = [
  "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  "/opt/pw-browsers/chromium/chrome-linux/chrome",
];

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "  ok" : "NOT OK"}  ${name}${detail ? "  — " + detail : ""}`);
}

const shots = path.join(here, "shots");
fs.mkdirSync(shots, { recursive: true });

const userDataDir = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "ext-e2e-"));
const executablePath = CHROME_PATHS.find((p) => fs.existsSync(p));

const context = await chromium.launchPersistentContext(userDataDir, {
  executablePath,
  args: [
    `--disable-extensions-except=${root}`,
    `--load-extension=${root}`,
    "--no-sandbox",
  ],
  viewport: { width: 420, height: 900 },
});

try {
  // ---------------------------------------------------------- 1. 扩展加载
  let worker = context.serviceWorkers()[0];
  if (!worker) {
    worker = await context.waitForEvent("serviceworker", { timeout: 15000 });
  }
  const extensionId = new URL(worker.url()).host;
  check("扩展被 Chromium 接受并起了 service worker", Boolean(extensionId), extensionId);

  const workerErrors = [];
  worker.on("console", (msg) => {
    if (msg.type() === "error") workerErrors.push(msg.text());
  });

  // background 里的看板客户端加载了没有
  const deskLoaded = await worker.evaluate(() => Boolean(globalThis.ResumeDeskClient));
  check("background 里挂上了看板客户端", deskLoaded === true);

  const deskBase = await worker.evaluate(() => globalThis.ResumeDeskClient.DEFAULT_BASE);
  check("看板默认地址是本机 8765", deskBase === "http://127.0.0.1:8765", deskBase);

  // 外部地址会被挡掉
  const rejected = await worker.evaluate(() =>
    globalThis.ResumeDeskClient.normalizeBase("http://evil.example.com")
  );
  check("外部地址被挡回默认值", rejected === "http://127.0.0.1:8765", rejected);

  // ---------------------------------------------------------- 2. 侧边栏
  const panel = await context.newPage();
  const panelErrors = [];
  panel.on("pageerror", (err) => panelErrors.push(String(err)));
  panel.on("console", (msg) => {
    if (msg.type() === "error") panelErrors.push(msg.text());
  });

  await panel.goto(`chrome-extension://${extensionId}/popup.html`, {
    waitUntil: "domcontentloaded",
  });
  await panel.waitForTimeout(1200);

  const tabs = await panel.$$eval("#tabs .tab", (nodes) =>
    nodes.map((n) => n.textContent.trim())
  );
  check("侧边栏多出了「岗位与看板」这个页签", tabs.includes("岗位与看板"), tabs.join(" / "));

  await panel.click('#tabs .tab[data-tab="jobs"]');
  await panel.waitForTimeout(400);

  for (const id of ["checkRequiredBtn", "captureJobBtn", "markSubmittedBtn", "pingDeskBtn"]) {
    const visible = await panel.isVisible("#" + id);
    check(`按钮 #${id} 可见`, visible);
  }

  const baseValue = await panel.inputValue("#deskBaseInput");
  check("看板地址输入框已经回填", baseValue === "http://127.0.0.1:8765", baseValue);

  await panel.screenshot({ path: path.join(shots, "side-panel-jobs.png"), fullPage: true });
  await panel.click('#tabs .tab[data-tab="fill"]');
  await panel.waitForTimeout(300);
  await panel.screenshot({ path: path.join(shots, "side-panel-fill.png"), fullPage: true });

  check("侧边栏没有 JS 报错", panelErrors.length === 0, panelErrors.join(" | "));

  // ---------------------------------------------------------- 3. 真 DOM 上跑新动作
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(String(err)));

  // content.js 一上来就挂 chrome.runtime.onMessage，普通页面没有这个 API，
  // 所以先塞一个最小的假 chrome 进去，并把注册的 listener 留出来给我们调。
  await page.addInitScript(() => {
    const store = {};
    window.__listeners = [];
    window.chrome = {
      runtime: {
        id: "test",
        onMessage: {
          addListener: (fn) => window.__listeners.push(fn),
        },
        sendMessage: (_msg, cb) => cb && cb({ success: true }),
      },
      storage: {
        local: {
          get: async (key) =>
            typeof key === "string" ? { [key]: store[key] } : { ...store },
          set: async (patch) => Object.assign(store, patch),
        },
      },
    };
  });

  await page.goto("file://" + path.join(here, "test-form.html"));

  for (const file of [
    "shared/resume-schema.js",
    "shared/diagnostics.js",
    "shared/field-text.js",
    "shared/field-semantics.js",
    "shared/fill-runtime.js",
    "shared/content-bridge.js",
    "shared/ai-client.js",
    "shared/job-capture.js",
    "shared/required-check.js",
    "shared/fill-override.js",
    "content.js",
  ]) {
    await page.addScriptTag({ path: path.join(root, file) });
  }
  await page.waitForTimeout(300);

  check("content.js 在页面里注册了消息监听", await page.evaluate(() => window.__listeners.length > 0));

  const ask = (action) =>
    page.evaluate(
      (act) =>
        new Promise((resolve) => {
          let settled = false;
          const done = (value) => {
            if (!settled) {
              settled = true;
              resolve(value);
            }
          };
          window.__listeners[0]({ action: act }, {}, done);
          setTimeout(() => done({ success: false, message: "超时" }), 6000);
        }),
      action
    );

  // --- ping：看看新能力有没有报出来
  const pong = await ask("ping");
  check(
    "ping 报告了三个新能力",
    pong?.capabilities?.captureJob === true &&
      pong?.capabilities?.checkRequired === true &&
      pong?.capabilities?.fillOverride === true,
    JSON.stringify(pong?.capabilities)
  );

  // --- 一键存岗位
  const captured = await ask("captureJob");
  const job = captured?.job || {};
  check("识别出岗位名", job.title === "产品岗（校招）", job.title);
  check("识别出公司（从标题里）", job.company === "汇添富基金", job.company);
  check("识别出城市", job.city === "上海", job.city);
  check("抓到了岗位描述", (job.jd || "").includes("新产品设计与申报"), String(job.jd || "").slice(0, 40));

  // --- 必填项检查
  const checked = await ask("checkRequired");
  const result = checked?.result || {};
  const labels = (result.missing || []).map((m) => m.label);

  check("认出了 DOM 的 required（姓名）", labels.includes("姓名"), labels.join("、"));
  check("认出了写着「必填」的手机号", labels.includes("手机号（必填）") || labels.some((l) => l.includes("手机")), labels.join("、"));
  check("认出了全角星号的邮箱是必填，但它已经有值所以不报", !labels.includes("邮箱"), labels.join("、"));
  check("认出了自我介绍的半角星号", labels.some((l) => l.includes("自我介绍")), labels.join("、"));
  check("「备注（选填）」没有被误报", !labels.some((l) => l.includes("备注")), labels.join("、"));
  check("「毕业院校」没有被误报", !labels.some((l) => l.includes("毕业院校")), labels.join("、"));
  check("简历附件被单独列进文件字段", (result.files || []).some((f) => f.label.includes("简历")), JSON.stringify(result.files));

  const highlighted = await page.$$eval(".ai-resume-missing-required", (n) => n.length);
  check("缺的必填项在页面上标红了", highlighted >= 3, String(highlighted));

  // 最要紧的一条：什么都没被提交
  const submitted = await page.evaluate(() => window.__formSubmitted === true);
  check("表单没有被提交", submitted === false);

  await page.screenshot({ path: path.join(shots, "form-checked.png"), fullPage: true });
  check("页面没有 JS 报错", pageErrors.length === 0, pageErrors.join(" | "));
  check("service worker 没有报错", workerErrors.length === 0, workerErrors.join(" | "));
} finally {
  await context.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log("");
console.log(`共 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
console.log(`截图在 ${shots}`);
process.exit(failed.length ? 1 : 0);
