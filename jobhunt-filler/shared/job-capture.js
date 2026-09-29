/* 从当前页面认出「这是哪家公司的哪个岗位」。
 *
 * 分两层：
 *   · collectSignals() 在 content.js 里跑，负责从 DOM 里捞原料；
 *   · extractFromSignals() 是纯函数，拿原料出结果，可以直接测。
 *
 * 认不准没关系——存进看板之后可以改。目标是省掉手打公司名和链接，
 * 不是做到百分百正确。
 */

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.ResumeJobCapture = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const MAX_JD_LENGTH = 6000;

  // 标题里常见的分隔符，用来把「岗位 - 公司 - 招聘」拆开
  const TITLE_SEPARATORS = /\s*[|｜\-—–_·•]\s*|\s+[-–—]\s+/;

  // 这些词出现在标题片段里，说明它是网站名而不是岗位名
  const SITE_NOISE = [
    "招聘", "校园招聘", "社会招聘", "校招", "社招", "人才招聘", "招聘官网",
    "career", "careers", "job", "jobs", "recruit", "recruitment", "hiring",
    "招聘网", "官网", "首页",
  ];

  const CITY_HINTS = /(工作地点|工作城市|办公地点|base地|Base|地点|城市)\s*[:：]?\s*([^\s，,。;；|｜\n\r]{2,20})/;

  const KNOWN_CITIES = [
    "北京", "上海", "广州", "深圳", "杭州", "南京", "苏州", "成都", "重庆",
    "武汉", "西安", "天津", "青岛", "厦门", "宁波", "长沙", "郑州", "合肥",
    "福州", "济南", "大连", "沈阳", "昆山", "珠海", "东莞", "佛山", "无锡",
    "香港", "澳门", "台北", "新加坡",
  ];

  function text(value) {
    return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  }

  function hostOf(url) {
    try {
      return new URL(String(url)).hostname.toLowerCase();
    } catch (error) {
      return "";
    }
  }

  function pathPartsOf(url) {
    try {
      return new URL(String(url)).pathname.split("/").filter(Boolean);
    } catch (error) {
      return [];
    }
  }

  /** 认出这是哪套招聘系统。看板那边也有一份同样的判断。 */
  function detectAts(url) {
    const host = hostOf(url);
    if (!host) return "";
    const table = [
      ["zhiye.com", "beisen"],
      ["mokahr.com", "moka"],
      ["myworkdayjobs.com", "workday"],
      ["successfactors", "successfactors"],
      ["avature", "avature"],
      ["careers.tencent.com", "tencent"],
      ["jobs.bytedance.com", "bytedance"],
      ["talent.alibaba.com", "alibaba"],
      ["dayee.com", "dayee"],
      ["greenhouse.io", "greenhouse"],
      ["lever.co", "lever"],
      ["ashbyhq.com", "ashby"],
    ];
    for (const [needle, name] of table) {
      if (host.includes(needle)) return name;
    }
    return "";
  }

  /** 从 URL 里猜公司代号。北森和 Moka 的租户名就在 URL 里，最准。 */
  function companyFromUrl(url) {
    const host = hostOf(url);
    if (!host) return "";
    if (host.endsWith(".zhiye.com")) {
      return host.slice(0, -".zhiye.com".length);
    }
    if (host.includes("mokahr.com")) {
      const parts = pathPartsOf(url);
      // /campus-recruitment/<租户>/<批次>，老批次是 /campus_apply/<租户>/<批次>
      const idx = parts.findIndex((p) => /recruit|apply/i.test(p));
      if (idx >= 0 && parts[idx + 1]) return parts[idx + 1];
      return parts.length >= 2 ? parts[1] : "";
    }
    if (host.includes("myworkdayjobs.com")) {
      return host.split(".")[0];
    }
    const parts = host
      .split(".")
      .filter((p) => !["www", "com", "cn", "net", "org", "jobs", "careers", "app", "talent"].includes(p));
    return parts[0] || "";
  }

  function looksLikeSiteName(fragment) {
    // 「产品岗（校招）」里也有「校招」，所以不能一命中就判死。
    // 把噪音词抠掉，剩不下两个字才算是网站名。
    let rest = String(fragment || "").toLowerCase();
    const ordered = SITE_NOISE.slice().sort((a, b) => b.length - a.length);
    ordered.forEach((word) => {
      rest = rest.split(word.toLowerCase()).join("");
    });
    rest = rest.replace(/[\s（）()\[\]【】·、,，.。:：/\\-]/g, "");
    return rest.length < 2;
  }

  /** 把 <title> 拆成片段，猜哪个是岗位、哪个是公司。 */
  function splitTitle(pageTitle) {
    const raw = text(pageTitle);
    if (!raw) return { title: "", company: "" };
    const parts = raw.split(TITLE_SEPARATORS).map(text).filter(Boolean);
    if (parts.length === 0) return { title: "", company: "" };
    if (parts.length === 1) return { title: parts[0], company: "" };

    const meaty = parts.filter((p) => !looksLikeSiteName(p));
    if (meaty.length === 0) return { title: parts[0], company: "" };
    if (meaty.length === 1) return { title: meaty[0], company: "" };

    // 中文页面多是「岗位 - 公司」，最后一段更可能是公司
    return { title: meaty[0], company: meaty[meaty.length - 1] };
  }

  function findCity(blob) {
    const raw = String(blob || "");
    const hit = raw.match(CITY_HINTS);
    if (hit && hit[2]) {
      const value = text(hit[2]);
      if (value && value.length <= 20) return value;
    }
    for (const city of KNOWN_CITIES) {
      if (raw.includes(city)) return city;
    }
    return "";
  }

  function trimJd(value) {
    const raw = String(value || "")
      .replace(/\r/g, "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (raw.length <= MAX_JD_LENGTH) return raw;
    return raw.slice(0, MAX_JD_LENGTH) + "\n…（已截断）";
  }

  /**
   * signals = {
   *   url, pageTitle, metas: {"og:title": "...", ...},
   *   headings: ["...", ...],      // h1/h2 的文本，按出现顺序
   *   atsTitle, atsCompany,        // 针对已知 ATS 的选择器命中的文本
   *   bodyText                     // 正文（尽量只取岗位描述那一块）
   * }
   */
  function extractFromSignals(signals) {
    const s = signals || {};
    const url = text(s.url);
    const metas = s.metas || {};
    const headings = (Array.isArray(s.headings) ? s.headings : []).map(text).filter(Boolean);

    const fromTitle = splitTitle(s.pageTitle || metas["og:title"] || "");

    const title =
      text(s.atsTitle) ||
      headings[0] ||
      text(metas["og:title"]) ||
      fromTitle.title ||
      "";

    const company =
      text(s.atsCompany) ||
      text(metas["og:site_name"]) ||
      fromTitle.company ||
      companyFromUrl(url) ||
      "";

    const jd = trimJd(s.bodyText);
    const city = findCity([s.atsCity, jd, headings.join(" "), s.pageTitle].join("\n"));

    return {
      company: company || "待补全",
      title: title || "待补全",
      city,
      url,
      ats: detectAts(url),
      jd,
      source: "extension",
    };
  }

  /** 结果够不够好？不够好就提示用户存完去看板补一下。 */
  function confidence(job) {
    let score = 0;
    if (job.company && job.company !== "待补全") score += 1;
    if (job.title && job.title !== "待补全") score += 1;
    if (job.city) score += 1;
    if (job.jd && job.jd.length > 80) score += 1;
    if (score >= 3) return "high";
    if (score >= 2) return "medium";
    return "low";
  }

  return {
    MAX_JD_LENGTH,
    detectAts,
    companyFromUrl,
    splitTitle,
    findCity,
    trimJd,
    extractFromSignals,
    confidence,
  };
});
