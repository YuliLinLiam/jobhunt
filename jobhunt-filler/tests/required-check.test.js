const test = require("node:test");
const assert = require("node:assert/strict");

const check = require("../shared/required-check.js");

function field(overrides) {
  return Object.assign(
    { fieldId: "f1", label: "姓名", kind: "text", hasValue: false },
    overrides
  );
}

test("DOM 上的 required 直接算必填", () => {
  const verdict = check.judge(field({ required: true }));
  assert.equal(verdict.required, true);
  assert.equal(verdict.basis, "DOM required");
});

test("aria-required 也算", () => {
  assert.equal(check.judge(field({ ariaRequired: true })).required, true);
});

test("标签带星号算必填——国产系统大半是这样标的", () => {
  for (const label of ["姓名*", "* 姓名", "姓名＊", "姓名 ✱"]) {
    assert.equal(check.judge(field({ label })).required, true, label);
  }
});

test("标签明写「必填」算必填", () => {
  assert.equal(check.judge(field({ label: "手机号（必填）" })).required, true);
  assert.equal(check.judge(field({ label: "Phone (required)" })).required, true);
});

test("写了「选填」就不算，哪怕带星号", () => {
  assert.equal(check.judge(field({ label: "备注（选填）" })).required, false);
  assert.equal(check.judge(field({ label: "*备注 选填" })).required, false);
});

test("普通标签不算必填", () => {
  assert.equal(check.judge(field({ label: "备注" })).required, false);
});

test("judge 对垃圾输入不炸", () => {
  assert.equal(check.judge(null).required, false);
  assert.equal(check.judge(undefined).required, false);
  assert.equal(check.judge("字符串").required, false);
});

test("cleanLabel 去掉星号和结尾的冒号", () => {
  assert.equal(check.cleanLabel("姓名*"), "姓名");
  assert.equal(check.cleanLabel("手机号："), "手机号");
  assert.equal(check.cleanLabel("* 邮箱 :"), "邮箱");
});

test("collectMissing 只报必填且没值的", () => {
  const result = check.collectMissing([
    field({ fieldId: "a", label: "姓名*", hasValue: true }),
    field({ fieldId: "b", label: "手机*", hasValue: false }),
    field({ fieldId: "c", label: "备注", hasValue: false }),
  ]);
  assert.equal(result.requiredTotal, 2);
  assert.equal(result.missing.length, 1);
  assert.equal(result.missing[0].fieldId, "b");
  assert.equal(result.ok, false);
});

test("全填完了就是 ok", () => {
  const result = check.collectMissing([
    field({ fieldId: "a", label: "姓名*", hasValue: true }),
  ]);
  assert.equal(result.ok, true);
  assert.match(check.summarize(result), /都有值了/);
});

test("文件字段单独列出来——简历附件最容易漏", () => {
  const result = check.collectMissing([
    field({ fieldId: "a", label: "姓名*", hasValue: true }),
    field({ fieldId: "r", label: "简历附件*", kind: "file", hasValue: false }),
  ]);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].label, "简历附件");
});

test("没有标签的字段也不会显示成空白", () => {
  const result = check.collectMissing([
    field({ fieldId: "x", label: "*", hasValue: false }),
  ]);
  assert.equal(result.missing[0].label, "(没有标签的字段)");
});

test("空页面和垃圾输入都不炸", () => {
  assert.equal(check.collectMissing([]).total, 0);
  assert.equal(check.collectMissing(null).total, 0);
  assert.match(check.summarize(check.collectMissing([])), /没扫到/);
});

test("一个必填都没识别出来时，结论要提醒用户自己看一眼", () => {
  const result = check.collectMissing([field({ label: "备注" })]);
  assert.match(check.summarize(result), /自己扫一眼/);
});
