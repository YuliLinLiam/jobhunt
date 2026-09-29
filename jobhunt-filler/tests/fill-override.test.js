const test = require("node:test");
const assert = require("node:assert/strict");

const override = require("../shared/fill-override.js");

test("值没变就不记", () => {
  assert.equal(override.isWorthRecording("张三", "张三"), false);
  assert.equal(override.isWorthRecording("张三", " 张三 "), false);
});

test("改成空的不记——那多半是用户在清空重填", () => {
  assert.equal(override.isWorthRecording("张三", ""), false);
  assert.equal(override.isWorthRecording("张三", "   "), false);
});

test("真改了才记", () => {
  assert.equal(override.isWorthRecording("张三", "李四"), true);
  assert.equal(override.isWorthRecording("", "补了一段"), true);
});

test("超长的值不记，别把 storage 撑爆", () => {
  const long = "字".repeat(override.MAX_VALUE_LENGTH + 1);
  assert.equal(override.isWorthRecording("", long), false);
});

test("recordCorrection 写进去能读出来", () => {
  const store = override.recordCorrection({}, {
    cacheKey: "host:abc",
    fieldId: "f_1",
    value: "上海市浦东新区",
    label: "通讯地址",
  });
  const page = override.overridesForPage(store, "host:abc");
  assert.equal(page.f_1.value, "上海市浦东新区");
  assert.equal(page.f_1.label, "通讯地址");
  assert.ok(page.f_1.updatedAt > 0);
});

test("recordCorrection 不改原对象", () => {
  const before = {};
  const after = override.recordCorrection(before, {
    cacheKey: "k", fieldId: "f", value: "v",
  });
  assert.deepEqual(before, {});
  assert.notEqual(before, after);
});

test("同一个字段再改一次是覆盖，不是堆积", () => {
  let store = override.recordCorrection({}, { cacheKey: "k", fieldId: "f", value: "第一次" });
  store = override.recordCorrection(store, { cacheKey: "k", fieldId: "f", value: "第二次" });
  assert.equal(Object.keys(store.k).length, 1);
  assert.equal(store.k.f.value, "第二次");
});

test("缺 cacheKey 或 fieldId 时安静地什么都不做", () => {
  assert.deepEqual(override.recordCorrection({}, { fieldId: "f", value: "v" }), {});
  assert.deepEqual(override.recordCorrection({}, { cacheKey: "k", value: "v" }), {});
  assert.deepEqual(override.recordCorrection({}, null), {});
});

test("空值不写进去", () => {
  assert.deepEqual(override.recordCorrection({}, { cacheKey: "k", fieldId: "f", value: "  " }), {});
});

test("同一页记太多字段时丢掉最旧的", () => {
  let store = {};
  const total = override.MAX_FIELDS_PER_KEY + 10;
  for (let i = 0; i < total; i++) {
    store = override.recordCorrection(store, {
      cacheKey: "k", fieldId: "f_" + i, value: "v" + i,
    });
    // 让时间戳有先后，否则排序没有意义
    store.k["f_" + i].updatedAt = 1000 + i;
  }
  assert.equal(Object.keys(store.k).length, override.MAX_FIELDS_PER_KEY);
  assert.ok(!store.k.f_0, "最旧的应该被丢掉");
  assert.ok(store.k["f_" + (total - 1)], "最新的应该还在");
});

test("记了太多页时丢掉最旧的页", () => {
  let store = {};
  const total = override.MAX_KEYS + 5;
  for (let i = 0; i < total; i++) {
    store = override.recordCorrection(store, {
      cacheKey: "page_" + i, fieldId: "f", value: "v",
    });
    store["page_" + i].f.updatedAt = 1000 + i;
  }
  assert.equal(Object.keys(store).length, override.MAX_KEYS);
  assert.ok(!store.page_0);
  assert.ok(store["page_" + (total - 1)]);
});

test("forgetCorrection 删掉一条，页空了就把整页删掉", () => {
  let store = override.recordCorrection({}, { cacheKey: "k", fieldId: "f", value: "v" });
  store = override.forgetCorrection(store, "k", "f");
  assert.deepEqual(store, {});
});

test("forgetCorrection 删不存在的东西不炸", () => {
  assert.deepEqual(override.forgetCorrection({}, "k", "f"), {});
  assert.deepEqual(override.forgetCorrection(null, "k", "f"), {});
});

test("overridesForPage 过滤掉坏数据", () => {
  const store = {
    k: {
      good: { value: "ok" },
      empty: { value: "" },
      wrongType: { value: 123 },
      notObject: "字符串",
    },
  };
  const page = override.overridesForPage(store, "k");
  assert.deepEqual(Object.keys(page), ["good"]);
});

test("overridesForPage 对不存在的页返回空对象而不是 undefined", () => {
  assert.deepEqual(override.overridesForPage({}, "没有这页"), {});
  assert.deepEqual(override.overridesForPage(null, "k"), {});
});

test("countOverrides 数的是字段总数，不是页数", () => {
  let store = override.recordCorrection({}, { cacheKey: "a", fieldId: "1", value: "v" });
  store = override.recordCorrection(store, { cacheKey: "a", fieldId: "2", value: "v" });
  store = override.recordCorrection(store, { cacheKey: "b", fieldId: "1", value: "v" });
  assert.equal(override.countOverrides(store), 3);
  assert.equal(override.countOverrides(null), 0);
});

test("没有 chrome.storage 时 load 返回空对象而不是抛异常", async () => {
  assert.deepEqual(await override.load(), {});
});
