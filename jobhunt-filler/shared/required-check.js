/* 提交前的必填项检查。
 *
 * 扫描的时候本来就采到了 required，只是从来没人把「还差哪些」汇总出来。
 * 这里补上，并且多认一种情况：很多国产招聘系统的必填只在标签上画一个
 * 星号，DOM 里并没有 required 属性——光看 required 会漏掉一大半。
 *
 * 纯函数，不碰 DOM，方便测。
 */

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.ResumeRequiredCheck = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // 标签上的星号：全角半角都算，前置后置都算
  const STAR_RE = /[*＊✱∗]/;
  // 明说必填的字样
  const REQUIRED_WORDS = /(必填|必须填写|required|\(必\)|（必）)/i;
  // 明说选填的字样——出现这个就别误报
  const OPTIONAL_WORDS = /(选填|非必填|可不填|optional)/i;

  function text(value) {
    return String(value == null ? "" : value).trim();
  }

  /** 光看标签，这个字段像不像必填？ */
  function looksRequiredByLabel(label) {
    const raw = text(label);
    if (!raw) return false;
    if (OPTIONAL_WORDS.test(raw)) return false;
    if (REQUIRED_WORDS.test(raw)) return true;
    return STAR_RE.test(raw);
  }

  /** 判定一个字段是不是必填，并说明依据（依据要展示给用户看）。 */
  function judge(field) {
    if (!field || typeof field !== "object") {
      return { required: false, basis: "" };
    }
    if (field.required === true) {
      return { required: true, basis: "DOM required" };
    }
    if (field.ariaRequired === true) {
      return { required: true, basis: "aria-required" };
    }
    // 上游的标签提取器会把星号这类装饰去掉，所以星号要从原始文本上认。
    const label = [text(field.rawLabel), text(field.label)].filter(Boolean).join(" ");
    if (OPTIONAL_WORDS.test(label)) {
      return { required: false, basis: "" };
    }
    if (REQUIRED_WORDS.test(label)) {
      return { required: true, basis: "标签写了必填" };
    }
    if (STAR_RE.test(label)) {
      return { required: true, basis: "标签带星号" };
    }
    return { required: false, basis: "" };
  }

  /** 把标签上的星号和冒号去掉，展示时干净一些。 */
  function cleanLabel(label) {
    return text(label)
      .replace(STAR_RE, "")
      .replace(/[:：]\s*$/, "")
      .trim();
  }

  /**
   * 汇总还没填的必填项。
   *
   * fields: [{ fieldId, label, required, ariaRequired, kind, sectionLabel, hasValue }]
   * hasValue 由调用方（content.js）用 hasExistingFieldValue 算好传进来，
   * 这样这里就完全不依赖 DOM。
   */
  function collectMissing(fields) {
    const list = Array.isArray(fields) ? fields : [];
    const missing = [];
    let requiredTotal = 0;

    list.forEach((field) => {
      const verdict = judge(field);
      if (!verdict.required) return;
      requiredTotal += 1;
      if (field.hasValue) return;
      missing.push({
        fieldId: field.fieldId,
        label: cleanLabel(field.label) || "(没有标签的字段)",
        sectionLabel: text(field.sectionLabel),
        kind: text(field.kind) || "text",
        basis: verdict.basis,
      });
    });

    // 文件上传单独拎出来：扩展本来就不填它，但它常常是必填，
    // 不提醒的话最容易漏掉简历附件。
    const files = list
      .filter((field) => text(field.kind) === "file")
      .map((field) => ({
        fieldId: field.fieldId,
        label: cleanLabel(field.label) || "文件上传",
        sectionLabel: text(field.sectionLabel),
        kind: "file",
        basis: "文件字段需要你自己上传",
      }));

    return {
      total: list.length,
      requiredTotal,
      missing,
      files,
      ok: missing.length === 0,
    };
  }

  /** 一句话结论，直接显示在侧边栏。 */
  function summarize(result) {
    if (!result) return "没有检查结果";
    if (result.total === 0) return "这个页面没扫到可填写的字段";
    if (result.requiredTotal === 0) {
      return `扫到 ${result.total} 个字段，没有识别出必填项——保险起见还是自己扫一眼`;
    }
    if (result.ok) {
      return `${result.requiredTotal} 个必填项都有值了`;
    }
    return `还有 ${result.missing.length} 个必填项是空的（共 ${result.requiredTotal} 个必填）`;
  }

  return {
    looksRequiredByLabel,
    judge,
    cleanLabel,
    collectMissing,
    summarize,
  };
});
