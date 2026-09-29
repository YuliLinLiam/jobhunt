/* 手工更正回写。
 *
 * 原来的行为：映射缓存只省模型调用，不学东西。你手工改过的字段，
 * 下次填同一页还是按老映射覆盖回去，每次都得返工。
 *
 * 这里补的就是那个闭环：填完之后盯一下这个控件，如果你把值改了，
 * 就把「这一页的这个字段 → 你改成的值」记下来，下次直接按你的来。
 *
 * 记的是值，不是 resumePath。因为你手改的原因通常是
 * 「母版里没有这个东西」或者「这家要的写法不一样」，
 * 记路径解决不了，记值才解决。
 */

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.ResumeFillOverride = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const STORAGE_KEY = "fieldOverridesV1";
  const MAX_KEYS = 80;          // 最多记 80 个页面
  const MAX_FIELDS_PER_KEY = 60; // 每页最多 60 个字段
  const MAX_VALUE_LENGTH = 2000;

  function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  /** 值得记下来吗：空的、和填进去的一样的、超长的，都不记。 */
  function isWorthRecording(filledValue, userValue) {
    const before = String(filledValue == null ? "" : filledValue).trim();
    const after = String(userValue == null ? "" : userValue).trim();
    if (!after) return false;
    if (after === before) return false;
    if (after.length > MAX_VALUE_LENGTH) return false;
    return true;
  }

  /** 把一条更正写进 store，返回新的 store（不改原对象）。 */
  function recordCorrection(store, entry) {
    const { cacheKey, fieldId, value, label } = entry || {};
    if (!cacheKey || !fieldId) return isPlainObject(store) ? store : {};
    const text = String(value == null ? "" : value);
    if (!text.trim() || text.length > MAX_VALUE_LENGTH) {
      return isPlainObject(store) ? store : {};
    }

    const next = isPlainObject(store) ? Object.assign({}, store) : {};
    const page = Object.assign({}, isPlainObject(next[cacheKey]) ? next[cacheKey] : {});

    page[fieldId] = {
      value: text,
      label: String(label || ""),
      updatedAt: Date.now(),
    };

    next[cacheKey] = pruneFields(page);
    return prunePages(next);
  }

  /** 忘掉一条（用户说「别再这么填了」时用）。 */
  function forgetCorrection(store, cacheKey, fieldId) {
    if (!isPlainObject(store) || !store[cacheKey]) return store || {};
    const next = Object.assign({}, store);
    const page = Object.assign({}, next[cacheKey]);
    delete page[fieldId];
    if (Object.keys(page).length === 0) {
      delete next[cacheKey];
    } else {
      next[cacheKey] = page;
    }
    return next;
  }

  /** 一页的更正太多就丢掉最旧的。 */
  function pruneFields(page) {
    const ids = Object.keys(page);
    if (ids.length <= MAX_FIELDS_PER_KEY) return page;
    ids.sort((a, b) => (page[b]?.updatedAt || 0) - (page[a]?.updatedAt || 0));
    const kept = {};
    ids.slice(0, MAX_FIELDS_PER_KEY).forEach((id) => {
      kept[id] = page[id];
    });
    return kept;
  }

  /** 记了太多页就丢掉最旧的那些页。 */
  function prunePages(store) {
    const keys = Object.keys(store);
    if (keys.length <= MAX_KEYS) return store;
    const freshness = (key) => {
      const page = store[key] || {};
      return Object.keys(page).reduce(
        (max, id) => Math.max(max, page[id]?.updatedAt || 0),
        0
      );
    };
    keys.sort((a, b) => freshness(b) - freshness(a));
    const kept = {};
    keys.slice(0, MAX_KEYS).forEach((key) => {
      kept[key] = store[key];
    });
    return kept;
  }

  /** 取出某一页的更正，顺便过滤掉坏数据。 */
  function overridesForPage(store, cacheKey) {
    if (!isPlainObject(store) || !cacheKey) return {};
    const page = store[cacheKey];
    if (!isPlainObject(page)) return {};
    const out = {};
    Object.keys(page).forEach((fieldId) => {
      const item = page[fieldId];
      if (isPlainObject(item) && typeof item.value === "string" && item.value) {
        out[fieldId] = item;
      }
    });
    return out;
  }

  function countOverrides(store) {
    if (!isPlainObject(store)) return 0;
    return Object.keys(store).reduce(
      (sum, key) => sum + Object.keys(store[key] || {}).length,
      0
    );
  }

  // ---------------------------------------------------------- 存储

  async function load() {
    if (typeof chrome === "undefined" || !chrome?.storage?.local) return {};
    const data = await chrome.storage.local.get(STORAGE_KEY);
    const store = data?.[STORAGE_KEY];
    return isPlainObject(store) ? store : {};
  }

  async function save(store) {
    if (typeof chrome === "undefined" || !chrome?.storage?.local) return;
    await chrome.storage.local.set({ [STORAGE_KEY]: store || {} });
  }

  async function remember(entry) {
    const store = await load();
    const next = recordCorrection(store, entry);
    await save(next);
    return next;
  }

  async function forPage(cacheKey) {
    return overridesForPage(await load(), cacheKey);
  }

  async function clearAll() {
    await save({});
  }

  return {
    STORAGE_KEY,
    MAX_KEYS,
    MAX_FIELDS_PER_KEY,
    MAX_VALUE_LENGTH,
    isWorthRecording,
    recordCorrection,
    forgetCorrection,
    overridesForPage,
    countOverrides,
    load,
    save,
    remember,
    forPage,
    clearAll,
  };
});
