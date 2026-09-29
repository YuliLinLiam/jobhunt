const test = require("node:test");
const assert = require("node:assert/strict");

const capture = require("../shared/job-capture.js");

test("detectAts 认得出常见的招聘系统", () => {
  const cases = {
    "https://htffund.zhiye.com/Campus": "beisen",
    "https://app.mokahr.com/campus-recruitment/jsfund/43906": "moka",
    "https://citi.wd5.myworkdayjobs.com/x": "workday",
    "https://careers.tencent.com/jobdesc.html": "tencent",
    "https://example.com/careers": "",
    "不是一个链接": "",
  };
  for (const [url, expected] of Object.entries(cases)) {
    assert.equal(capture.detectAts(url), expected, url);
  }
});

test("companyFromUrl 从北森的二级域名里取租户名", () => {
  assert.equal(capture.companyFromUrl("https://htffund.zhiye.com/Campus"), "htffund");
  assert.equal(capture.companyFromUrl("https://csc108.zhiye.com/campus/jobs"), "csc108");
});

test("companyFromUrl 从 Moka 的路径里取租户名", () => {
  assert.equal(
    capture.companyFromUrl("https://app.mokahr.com/campus-recruitment/jsfund/43906"),
    "jsfund"
  );
  assert.equal(
    capture.companyFromUrl("https://app-tc.mokahr.com/campus_apply/webankhr/18005"),
    "webankhr"
  );
});

test("companyFromUrl 对不认识的域名退回主域名", () => {
  assert.equal(capture.companyFromUrl("https://www.bytedance.com/jobs/1"), "bytedance");
  assert.equal(capture.companyFromUrl("乱写的"), "");
});

test("splitTitle 把「岗位 - 公司 - 招聘」拆开并丢掉网站名", () => {
  const out = capture.splitTitle("产品经理（校招） - 汇添富基金 - 校园招聘");
  assert.equal(out.title, "产品经理（校招）");
  assert.equal(out.company, "汇添富基金");
});

test("splitTitle 只有一段时不硬猜公司", () => {
  const out = capture.splitTitle("产品经理");
  assert.equal(out.title, "产品经理");
  assert.equal(out.company, "");
});

test("splitTitle 全是网站名时至少留下第一段", () => {
  const out = capture.splitTitle("校园招聘 | 招聘官网");
  assert.equal(out.title, "校园招聘");
});

test("findCity 优先认「工作地点：」这种明写的", () => {
  assert.equal(capture.findCity("工作地点：深圳\n其他内容提到了上海"), "深圳");
  assert.equal(capture.findCity("工作城市: 杭州"), "杭州");
});

test("findCity 没有明写时退回已知城市名", () => {
  assert.equal(capture.findCity("我们在上海办公"), "上海");
  assert.equal(capture.findCity("完全没有城市"), "");
});

test("trimJd 压掉多余空行并在超长时截断", () => {
  assert.equal(capture.trimJd("a\n\n\n\nb"), "a\n\nb");
  const long = "字".repeat(capture.MAX_JD_LENGTH + 500);
  const out = capture.trimJd(long);
  assert.ok(out.length < long.length);
  assert.ok(out.endsWith("（已截断）"));
});

test("extractFromSignals 走通一次北森页面", () => {
  const job = capture.extractFromSignals({
    url: "https://htffund.zhiye.com/Campus/Position/12345",
    pageTitle: "产品岗（校招） - 校园招聘",
    metas: {},
    headings: ["产品岗（校招）", "岗位职责"],
    atsTitle: "产品岗（校招）",
    bodyText: "工作地点：上海\n岗位职责：\n1. 新产品设计与申报\n2. 存续产品管理",
  });
  assert.equal(job.title, "产品岗（校招）");
  assert.equal(job.company, "htffund");
  assert.equal(job.city, "上海");
  assert.equal(job.ats, "beisen");
  assert.match(job.jd, /新产品设计与申报/);
  assert.equal(job.source, "extension");
});

test("extractFromSignals 什么都认不出来时给「待补全」而不是空", () => {
  const job = capture.extractFromSignals({ url: "", pageTitle: "", metas: {} });
  assert.equal(job.company, "待补全");
  assert.equal(job.title, "待补全");
  assert.equal(capture.confidence(job), "low");
});

test("extractFromSignals 不会因为传进来的是 null 就炸", () => {
  const job = capture.extractFromSignals(null);
  assert.equal(job.company, "待补全");
});

test("confidence 认得出识别得好的那次", () => {
  const job = capture.extractFromSignals({
    url: "https://app.mokahr.com/campus-recruitment/jsfund/1",
    pageTitle: "风控合规 - 嘉实基金",
    metas: {},
    headings: ["风控合规"],
    bodyText: "工作地点：上海\n" + "岗位描述".repeat(40),
  });
  assert.equal(capture.confidence(job), "high");
});

test("og:site_name 优先于从标题里猜的公司名", () => {
  const job = capture.extractFromSignals({
    url: "https://example.com/j/1",
    pageTitle: "岗位 - 猜错的公司",
    metas: { "og:site_name": "真正的公司" },
    headings: ["岗位"],
    bodyText: "",
  });
  assert.equal(job.company, "真正的公司");
});
