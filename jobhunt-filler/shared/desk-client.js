/* 和本机求职看板说话。
 *
 * 看板是另一个项目（jobhunt-desk），跑在 127.0.0.1 上。
 * 请求统一从 background 发——侧边栏和内容脚本都不直接 fetch，
 * 这样只有一处需要处理超时和「看板没开」这种情况。
 */

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.ResumeDeskClient = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const STORAGE_KEY = "deskBaseUrl";
  const DEFAULT_BASE = "http://127.0.0.1:8765";
  const TIMEOUT_MS = 4000;

  /** 只允许本机地址。看板里有你全部的求职记录，不该往别处发。 */
  function isLocalBase(value) {
    let parsed;
    try {
      parsed = new URL(String(value));
    } catch (error) {
      return false;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    return host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
  }

  function normalizeBase(value) {
    const raw = String(value || "").trim();
    if (!raw) return DEFAULT_BASE;
    const withScheme = /^https?:\/\//i.test(raw) ? raw : "http://" + raw;
    if (!isLocalBase(withScheme)) return DEFAULT_BASE;
    return withScheme.replace(/\/+$/, "");
  }

  async function getBase() {
    if (typeof chrome === "undefined" || !chrome?.storage?.local) return DEFAULT_BASE;
    const data = await chrome.storage.local.get(STORAGE_KEY);
    return normalizeBase(data?.[STORAGE_KEY]);
  }

  async function setBase(value) {
    const base = normalizeBase(value);
    if (typeof chrome !== "undefined" && chrome?.storage?.local) {
      await chrome.storage.local.set({ [STORAGE_KEY]: base });
    }
    return base;
  }

  /** 把各种失败翻译成人能看懂的一句话。 */
  function explainError(error, base) {
    const message = String(error?.message || error || "");
    if (message.includes("aborted") || message.includes("timeout")) {
      return `看板没有响应（${base}）。确认一下 python3 run.py 是不是还开着。`;
    }
    if (
      /failed to fetch|fetch failed|networkerror|econnrefused|load failed/i.test(message)
    ) {
      return `连不上看板（${base}）。先在看板目录下跑 python3 run.py。`;
    }
    return message || "请求看板失败";
  }

  /** 真正发请求的那一层，只在 background 里跑。 */
  async function request(path, options) {
    const base = await getBase();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(base + path, Object.assign({
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
      }, options || {}));
      const raw = await res.text();
      let data = {};
      try {
        data = raw ? JSON.parse(raw) : {};
      } catch (error) {
        throw new Error("看板返回的不是 JSON，确认一下地址对不对");
      }
      if (!res.ok) {
        throw new Error(data.error || `看板返回 ${res.status}`);
      }
      return data;
    } catch (error) {
      throw new Error(explainError(error, base));
    } finally {
      clearTimeout(timer);
    }
  }

  const post = (path, body) =>
    request(path, { method: "POST", body: JSON.stringify(body || {}) });

  return {
    STORAGE_KEY,
    DEFAULT_BASE,
    TIMEOUT_MS,
    isLocalBase,
    normalizeBase,
    explainError,
    getBase,
    setBase,
    request,
    ping: () => request("/api/overview"),
    capture: (job) => post("/api/capture", job),
    lookup: (url) => request("/api/lookup?url=" + encodeURIComponent(String(url || ""))),
    markSubmitted: (payload) => post("/api/submitted", payload),
  };
});
