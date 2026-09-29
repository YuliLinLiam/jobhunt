/* 求职工作台 — 前端。原生 JS，没有构建步骤。
 *
 * 一条纪律：任何来自数据库的文本都要经过 esc() 再拼进 HTML。
 * 岗位名、公司名、备注都是从网页上抓回来的，不能当作可信内容。
 */

'use strict';

const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

const STATUSES = ['想投', '已网申', '测评中', '面试中', '终面', 'Offer', '已挂', '已放弃'];
const BOARD_COLUMNS = ['想投', '已网申', '测评中', '面试中', '终面', 'Offer'];

const state = {
  page: 'today',
  jobs: [],
  filter: { status: '', q: '', track: '' },
  month: null,
  editing: null,
};

/* ------------------------------------------------------------ 工具 */

function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function api(path, options) {
  const res = await fetch(path, Object.assign({
    headers: { 'Content-Type': 'application/json' },
  }, options || {}));
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch (e) { data = { raw: text }; }
  if (!res.ok) throw new Error(data.error || ('请求失败 ' + res.status));
  return data;
}

const get = (path) => api(path);
const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body || {}) });
const patch = (path, body) => api(path, { method: 'PATCH', body: JSON.stringify(body || {}) });
const del = (path) => api(path, { method: 'DELETE' });

let toastTimer = null;
function toast(message, bad) {
  const el = $('#toast');
  el.textContent = message;
  el.className = 'toast show' + (bad ? ' bad' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 2600);
}

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function daysUntil(dateStr) {
  if (!dateStr) return null;
  const then = new Date(dateStr + 'T00:00:00');
  if (isNaN(then.getTime())) return null;
  const now = new Date(todayStr() + 'T00:00:00');
  return Math.round((then - now) / 86400000);
}

function ddlHtml(dateStr) {
  if (!dateStr) return '<span class="muted">—</span>';
  const n = daysUntil(dateStr);
  let cls = 'ddl';
  let suffix = '';
  if (n === null) return '<span class="ddl">' + esc(dateStr) + '</span>';
  if (n < 0) { cls += ' past'; suffix = ' 已过'; }
  else if (n === 0) { cls += ' today'; suffix = ' 今天'; }
  else if (n <= 3) { cls += ' soon'; suffix = ' ' + n + ' 天'; }
  else { suffix = ' ' + n + ' 天'; }
  return '<span class="' + cls + '">' + esc(dateStr) + '<span class="muted">' + suffix + '</span></span>';
}

function statusTag(status) {
  return '<span class="tag s-' + esc(status) + '">' + esc(status) + '</span>';
}

function linkOut(url) {
  if (!url) return '';
  return '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">打开 ↗</a>';
}

/* ------------------------------------------------------------ 路由 */

function go(page) {
  state.page = page;
  $$('#nav button').forEach((b) => b.classList.toggle('on', b.dataset.page === page));
  render();
}

$('#nav').addEventListener('click', (ev) => {
  const btn = ev.target.closest('button[data-page]');
  if (btn) go(btn.dataset.page);
});

const PAGES = {
  today: pageToday,
  jobs: pageJobs,
  board: pageBoard,
  calendar: pageCalendar,
  funnel: pageFunnel,
  add: pageAdd,
};

async function render() {
  const main = $('#main');
  main.innerHTML = '<div class="empty">加载中…</div>';
  try {
    await PAGES[state.page](main);
  } catch (err) {
    main.innerHTML = '<div class="panel"><div class="empty"><b>出错了</b>'
      + esc(err.message) + '</div></div>';
  }
}

function head(eyebrow, title, sub, actions) {
  return '<div class="page-head"><div>'
    + '<div class="eyebrow">' + esc(eyebrow) + '</div>'
    + '<h1>' + esc(title) + '</h1>'
    + (sub ? '<div class="sub">' + sub + '</div>' : '')
    + '</div><div class="chips">' + (actions || '') + '</div></div>';
}

/* ------------------------------------------------------------ 今日总览 */

async function pageToday(main) {
  const data = await get('/api/overview');
  $('#pill-jobs').textContent = data.total;

  const hour = new Date().getHours();
  const greet = hour < 6 ? '还没睡' : hour < 11 ? '早上好' : hour < 14 ? '中午好'
    : hour < 18 ? '下午好' : '晚上好';

  let html = head(data.today + ' · 今日求职总览', greet + '，今天从这几件事开始。',
    data.week_count + ' 个岗位七天内截止 · 进行中 ' + data.active + ' 个 · 累计已投 '
    + data.submitted + ' 个',
    '<button class="btn small" data-act="add">录入岗位</button>'
    + '<a class="btn small" href="/api/export.csv">导出 CSV</a>');

  html += '<div class="section-label">Today</div><div class="cards">'
    + card('待投', data.todo, '状态还是「想投」的')
    + card('本周 DDL', data.week_count, '未来七天截止')
    + card('进行中', data.active, '已投出、还没结果')
    + card('累计已投', data.submitted, '至少网申过一次')
    + (data.overdue.length
        ? '<div class="card alert"><div class="k">已过期</div><div class="v">'
          + data.overdue.length + '</div><div class="n">还挂在「想投」</div></div>'
        : '')
    + '</div>';

  html += '<div class="section-label">Deadlines</div>';
  html += '<div class="panel"><header><h2>七天内截止</h2>'
    + '<span class="hint">按截止日期升序，点一行看详情</span></header>'
    + '<div class="body flush">' + jobTable(data.week, '这七天没有待投的岗位。')
    + '</div></div>';

  if (data.overdue.length) {
    html += '<div class="section-label">Overdue</div>';
    html += '<div class="panel"><header><h2>已经过期但还挂在「想投」</h2>'
      + '<span class="hint">要么改成「已放弃」，要么确认一下是不是延期了</span></header>'
      + '<div class="body flush">' + jobTable(data.overdue, '') + '</div></div>';
  }

  html += '<div class="section-label">Recent</div>';
  html += '<div class="panel"><header><h2>最近录入</h2></header>'
    + '<div class="body flush">' + jobTable(data.recent, '还没有岗位，先去「录入岗位」加一条。')
    + '</div></div>';

  main.innerHTML = html;
  wireTable(main);
  const addBtn = main.querySelector('[data-act="add"]');
  if (addBtn) addBtn.addEventListener('click', () => go('add'));
}

function card(label, value, note) {
  return '<div class="card"><div class="k">' + esc(label) + '</div>'
    + '<div class="v">' + esc(value) + '</div>'
    + '<div class="n">' + esc(note) + '</div></div>';
}

/* ------------------------------------------------------------ 岗位清单 */

function jobTable(jobs, emptyText) {
  if (!jobs || !jobs.length) {
    return '<div class="empty"><b>空的</b>' + esc(emptyText || '没有符合条件的岗位。') + '</div>';
  }
  let html = '<table><thead><tr>'
    + '<th>公司 / 岗位</th><th>城市</th><th>状态</th><th>网申截止</th>'
    + '<th>下一步</th><th></th></tr></thead><tbody>';
  jobs.forEach((job) => {
    html += '<tr data-id="' + job.id + '">'
      + '<td><b>' + esc(job.company) + '</b><div class="muted">' + esc(job.title)
      + (job.track ? ' · ' + esc(job.track) : '') + '</div></td>'
      + '<td class="muted">' + esc(job.city || '—') + '</td>'
      + '<td>' + statusTag(job.status) + '</td>'
      + '<td class="num">' + ddlHtml(job.deadline) + '</td>'
      + '<td class="muted">' + esc(job.next_action || '—') + '</td>'
      + '<td class="num">' + linkOut(job.url) + '</td>'
      + '</tr>';
  });
  return html + '</tbody></table>';
}

function wireTable(root) {
  $$('tbody tr[data-id]', root).forEach((tr) => {
    tr.style.cursor = 'pointer';
    tr.addEventListener('click', (ev) => {
      if (ev.target.closest('a')) return;
      openDrawer(Number(tr.dataset.id));
    });
  });
}

async function pageJobs(main) {
  const params = new URLSearchParams();
  if (state.filter.status) params.set('status', state.filter.status);
  if (state.filter.q) params.set('q', state.filter.q);
  const data = await get('/api/jobs?' + params.toString());
  state.jobs = data.jobs;
  const all = await get('/api/overview');
  $('#pill-jobs').textContent = all.total;

  const chips = ['', '想投', '进行中', '已网申', '面试中', 'Offer', '已结束']
    .map((s) => '<button class="chip' + (state.filter.status === s ? ' on' : '')
      + '" data-status="' + esc(s) + '">' + esc(s || '全部') + '</button>').join('');

  main.innerHTML = head('岗位清单', '全部岗位',
    data.count + ' 条' + (state.filter.q ? ' · 搜索「' + esc(state.filter.q) + '」' : ''),
    '<a class="btn small" href="/api/export.csv">导出 CSV</a>')
    + '<div class="toolbar">'
    + '<input type="text" id="q" placeholder="搜公司、岗位、城市、备注" value="'
    + esc(state.filter.q) + '">'
    + '<button class="btn small" id="do-search">搜索</button>'
    + '<div class="chips">' + chips + '</div>'
    + '</div>'
    + '<div class="panel"><div class="body flush">'
    + jobTable(data.jobs, '换个筛选条件试试，或者去「录入岗位」加一条。')
    + '</div></div>';

  wireTable(main);
  $$('[data-status]', main).forEach((btn) => {
    btn.addEventListener('click', () => {
      state.filter.status = btn.dataset.status;
      render();
    });
  });
  const input = $('#q', main);
  const doSearch = () => { state.filter.q = input.value.trim(); render(); };
  $('#do-search', main).addEventListener('click', doSearch);
  input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') doSearch(); });
}

/* ------------------------------------------------------------ 看板 */

async function pageBoard(main) {
  const data = await get('/api/jobs?limit=2000&order=updated');
  const byStatus = {};
  BOARD_COLUMNS.forEach((s) => { byStatus[s] = []; });
  const closed = [];
  data.jobs.forEach((job) => {
    if (byStatus[job.status]) byStatus[job.status].push(job);
    else closed.push(job);
  });

  let html = head('投递台账', '拖卡片就是改状态',
    '状态改成「已网申」「测评中」「面试中」时会自动记下今天的日期');
  html += '<div class="board">';
  BOARD_COLUMNS.forEach((status) => {
    const list = byStatus[status];
    html += '<div class="column" data-status="' + esc(status) + '">'
      + '<h3><span>' + esc(status) + '</span><span>' + list.length + '</span></h3>';
    list.forEach((job) => {
      html += '<div class="kcard" draggable="true" data-id="' + job.id + '">'
        + '<b>' + esc(job.company) + '</b>'
        + '<div class="m">' + esc(job.title) + '</div>'
        + (job.deadline ? '<div class="m">DDL ' + esc(job.deadline) + '</div>' : '')
        + '</div>';
    });
    html += '</div>';
  });
  html += '</div>';

  if (closed.length) {
    html += '<div class="section-label">已结束 ' + closed.length + '</div>'
      + '<div class="panel"><div class="body flush">' + jobTable(closed, '') + '</div></div>';
  }
  main.innerHTML = html;
  wireTable(main);
  wireDragAndDrop(main);
}

function wireDragAndDrop(root) {
  let draggingId = null;
  $$('.kcard', root).forEach((cardEl) => {
    cardEl.addEventListener('dragstart', () => {
      draggingId = Number(cardEl.dataset.id);
      cardEl.classList.add('dragging');
    });
    cardEl.addEventListener('dragend', () => {
      cardEl.classList.remove('dragging');
      draggingId = null;
    });
    cardEl.addEventListener('click', () => openDrawer(Number(cardEl.dataset.id)));
  });
  $$('.column', root).forEach((col) => {
    col.addEventListener('dragover', (ev) => {
      ev.preventDefault();
      col.classList.add('drop');
    });
    col.addEventListener('dragleave', () => col.classList.remove('drop'));
    col.addEventListener('drop', async (ev) => {
      ev.preventDefault();
      col.classList.remove('drop');
      if (!draggingId) return;
      const status = col.dataset.status;
      try {
        await patch('/api/jobs/' + draggingId, { status });
        toast('已改成「' + status + '」');
        render();
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
}

/* ------------------------------------------------------------ 日历 */

async function pageCalendar(main) {
  const month = state.month || todayStr().slice(0, 7);
  const data = await get('/api/calendar?month=' + encodeURIComponent(month));

  const byDate = {};
  data.items.forEach((item) => {
    (byDate[item.date] = byDate[item.date] || []).push(item);
  });

  const [year, mon] = month.split('-').map(Number);
  const first = new Date(year, mon - 1, 1);
  const startPad = (first.getDay() + 6) % 7; // 周一开头
  const daysInMonth = new Date(year, mon, 0).getDate();
  const today = todayStr();

  let html = head('DDL 日历', month.replace('-', ' 年 ') + ' 月',
    data.items.length + ' 个日程 · 网申截止、测评、面试三种事件',
    '<button class="btn small" data-mv="-1">上个月</button>'
    + '<button class="btn small" data-mv="0">本月</button>'
    + '<button class="btn small" data-mv="1">下个月</button>');

  html += '<div class="cal">';
  ['一', '二', '三', '四', '五', '六', '日'].forEach((d) => {
    html += '<div class="dow">' + d + '</div>';
  });
  for (let i = 0; i < startPad; i++) html += '<div class="day out"></div>';
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = month + '-' + String(d).padStart(2, '0');
    const items = byDate[iso] || [];
    html += '<div class="day' + (iso === today ? ' today' : '') + '">'
      + '<div class="d">' + d + '</div>';
    items.slice(0, 4).forEach((item) => {
      html += '<div class="ev k' + esc(item.kind) + '" data-id="' + item.job_id + '" title="'
        + esc(item.kind + ' · ' + item.company + ' ' + item.title) + '">'
        + esc(item.company) + '</div>';
    });
    if (items.length > 4) {
      html += '<div class="ev">还有 ' + (items.length - 4) + ' 个</div>';
    }
    html += '</div>';
  }
  const tail = (7 - ((startPad + daysInMonth) % 7)) % 7;
  for (let i = 0; i < tail; i++) html += '<div class="day out"></div>';
  html += '</div>';

  html += '<div class="section-label">本月全部日程</div>'
    + '<div class="panel"><div class="body flush">';
  if (!data.items.length) {
    html += '<div class="empty"><b>这个月没有日程</b>给岗位填上网申截止日期，它们就会出现在这里。</div>';
  } else {
    html += '<table><thead><tr><th>日期</th><th>类型</th><th>公司 / 岗位</th><th>状态</th></tr></thead><tbody>';
    data.items.forEach((item) => {
      html += '<tr data-id="' + item.job_id + '">'
        + '<td class="num">' + esc(item.date) + '</td>'
        + '<td><span class="tag">' + esc(item.kind) + '</span></td>'
        + '<td><b>' + esc(item.company) + '</b><div class="muted">' + esc(item.title) + '</div></td>'
        + '<td>' + statusTag(item.status) + '</td></tr>';
    });
    html += '</tbody></table>';
  }
  html += '</div></div>';

  main.innerHTML = html;
  wireTable(main);
  $$('.ev[data-id]', main).forEach((el) => {
    el.addEventListener('click', () => openDrawer(Number(el.dataset.id)));
  });
  $$('[data-mv]', main).forEach((btn) => {
    btn.addEventListener('click', () => {
      const move = Number(btn.dataset.mv);
      if (move === 0) { state.month = todayStr().slice(0, 7); }
      else {
        const d = new Date(year, mon - 1 + move, 1);
        state.month = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
      }
      render();
    });
  });
}

/* ------------------------------------------------------------ 漏斗 */

async function pageFunnel(main) {
  const data = await get('/api/funnel');
  const tracks = await get('/api/tracks');
  const top = data.stages[0].count || 1;

  let html = head('漏斗', '从入库到 Offer，每一层还剩多少',
    '百分比是相对上一层的留存');
  html += '<div class="panel"><div class="body"><div class="funnel">';
  data.stages.forEach((stage) => {
    const width = Math.max(2, Math.round(stage.count * 100 / top));
    html += '<div class="frow">'
      + '<div class="name">' + esc(stage.stage) + '</div>'
      + '<div class="bar"><i style="width:' + width + '%"></i></div>'
      + '<div class="val"><b>' + stage.count + '</b>'
      + (stage.rate === null ? '' : ' · 上一层的 ' + stage.rate + '%')
      + '</div></div>';
  });
  html += '</div></div></div>';

  html += '<div class="section-label">按赛道</div><div class="panel"><div class="body flush">';
  if (!tracks.tracks.length) {
    html += '<div class="empty">还没有数据。</div>';
  } else {
    html += '<table><thead><tr><th>赛道</th><th>数量</th></tr></thead><tbody>';
    tracks.tracks.forEach((row) => {
      html += '<tr><td>' + esc(row.track) + '</td><td class="num">' + row.count + '</td></tr>';
    });
    html += '</tbody></table>';
  }
  html += '</div></div>';
  main.innerHTML = html;
}

/* ------------------------------------------------------------ 录入 */

function pageAdd(main) {
  main.innerHTML = head('录入岗位', '三种录入方式', '挑最省事的那个')
    + '<div class="panel"><header><h2>① 手工加一条</h2>'
    + '<span class="hint">只有公司和岗位是必填</span></header><div class="body">'
    + '<div class="grid2">'
    + field('company', '公司 *', 'text')
    + field('title', '岗位 *', 'text')
    + field('city', '城市', 'text')
    + field('deadline', '网申截止', 'date')
    + '</div>'
    + field('url', '投递链接', 'url')
    + '<div class="grid3">'
    + field('track', '赛道 / 方向', 'text')
    + field('company_type', '公司类型', 'text')
    + selectField('priority', '心仪程度', ['常规', '冲刺', '保底'])
    + '</div>'
    + '<label class="field"><span>备注</span><textarea id="f-note" rows="2"></textarea></label>'
    + '<button class="btn primary" id="do-create">加进来</button>'
    + '</div></div>'

    + '<div class="section-label">Batch</div>'
    + '<div class="panel"><header><h2>② 粘一批链接</h2>'
    + '<span class="hint">一行一个，或者整段文字里带链接也行</span></header><div class="body">'
    + '<textarea id="bulk-urls" rows="5" placeholder="https://htffund.zhiye.com/Campus&#10;https://app.mokahr.com/campus-recruitment/jsfund/43906"></textarea>'
    + '<div style="margin-top:10px"><button class="btn" id="do-urls">建成岗位</button>'
    + ' <span class="hint">公司名会按域名猜，进来之后可以改</span></div>'
    + '</div></div>'

    + '<div class="panel" style="margin-top:14px"><header><h2>③ CSV / 从表格里复制</h2>'
    + '<span class="hint">第一行是表头，逗号或 Tab 分隔都认</span></header><div class="body">'
    + '<div class="note">表头至少要有 <code>公司</code> 和 <code>岗位</code>。'
    + '其余可选：城市、投递链接、网申截止、状态、赛道、公司类型、心仪程度、备注。'
    + '英文列名 company / title / city / url / deadline / status 同样认。</div>'
    + '<textarea id="bulk-csv" rows="6" placeholder="公司,岗位,城市,网申截止&#10;汇添富基金,产品岗,上海,2026-10-15"></textarea>'
    + '<div style="margin-top:10px"><button class="btn" id="do-csv">导入</button></div>'
    + '</div></div>';

  $('#do-create', main).addEventListener('click', async () => {
    const payload = {
      company: $('#f-company').value.trim(),
      title: $('#f-title').value.trim(),
      city: $('#f-city').value.trim(),
      deadline: $('#f-deadline').value,
      url: $('#f-url').value.trim(),
      track: $('#f-track').value.trim(),
      company_type: $('#f-company_type').value.trim(),
      priority: $('#f-priority').value,
      note: $('#f-note').value.trim(),
      source: 'manual',
    };
    if (!payload.company || !payload.title) {
      return toast('公司和岗位是必填的', true);
    }
    try {
      await post('/api/jobs', payload);
      toast('已加进来');
      go('jobs');
    } catch (err) { toast(err.message, true); }
  });

  $('#do-urls', main).addEventListener('click', async () => {
    const text = $('#bulk-urls').value;
    if (!text.trim()) return toast('先粘点链接', true);
    try {
      const res = await post('/api/import/urls', { text });
      toast('新建 ' + res.created + ' 条，合并 ' + res.merged + ' 条');
      if (res.created) go('jobs');
    } catch (err) { toast(err.message, true); }
  });

  $('#do-csv', main).addEventListener('click', async () => {
    const text = $('#bulk-csv').value;
    if (!text.trim()) return toast('先粘点内容', true);
    try {
      const res = await post('/api/import/csv', { text });
      let msg = '新建 ' + res.created + ' 条，合并 ' + res.merged + ' 条';
      if (res.problems && res.problems.length) msg += '（' + res.problems[0] + '）';
      toast(msg);
      if (res.created) go('jobs');
    } catch (err) { toast(err.message, true); }
  });
}

function field(name, label, type) {
  return '<label class="field"><span>' + esc(label) + '</span>'
    + '<input type="' + type + '" id="f-' + name + '"></label>';
}

function selectField(name, label, options) {
  return '<label class="field"><span>' + esc(label) + '</span><select id="f-' + name + '">'
    + options.map((o) => '<option>' + esc(o) + '</option>').join('')
    + '</select></label>';
}

/* ------------------------------------------------------------ 抽屉 */

async function openDrawer(id) {
  const data = await get('/api/jobs/' + id);
  const job = data.job;
  state.editing = job;

  $('#dw-title').textContent = job.company;
  $('#dw-sub').textContent = job.title + (job.city ? ' · ' + job.city : '')
    + (job.ats ? ' · ' + job.ats : '');

  let html = '';
  if (job.url) {
    html += '<div class="note" style="margin-bottom:14px">投递链接 '
      + linkOut(job.url) + '</div>';
  }
  html += '<div class="grid2">'
    + dField('status', '状态', 'select', job.status, STATUSES)
    + dField('deadline', '网申截止', 'date', job.deadline)
    + dField('company', '公司', 'text', job.company)
    + dField('title', '岗位', 'text', job.title)
    + dField('city', '城市', 'text', job.city)
    + dField('track', '赛道', 'text', job.track)
    + dField('applied_at', '投递日期', 'date', job.applied_at)
    + dField('assess_at', '测评时间', 'date', job.assess_at)
    + dField('interview_at', '面试时间', 'date', job.interview_at)
    + dField('company_type', '公司类型', 'text', job.company_type)
    + '</div>'
    + dField('next_action', '下一步动作', 'text', job.next_action)
    + dField('url', '投递链接', 'url', job.url)
    + '<label class="field"><span>备注</span><textarea id="d-note" rows="3">'
    + esc(job.note) + '</textarea></label>';

  if (job.jd) {
    html += '<div class="section-label">岗位描述</div>'
      + '<div style="max-height:200px;overflow:auto;font-size:12.5px;color:var(--ink-2);'
      + 'white-space:pre-wrap;background:#faf9f6;border:1px solid var(--line);'
      + 'border-radius:8px;padding:10px">' + esc(job.jd) + '</div>';
  }

  html += '<div class="section-label">时间线</div><ul class="timeline">';
  (job.events || []).forEach((ev) => {
    html += '<li><b>' + esc(ev.kind) + '</b> ' + esc(ev.detail)
      + '<span class="t">' + esc(ev.at) + '</span></li>';
  });
  if (!job.events || !job.events.length) html += '<li class="muted">还没有记录</li>';
  html += '</ul>';

  $('#dw-body').innerHTML = html;
  $('#drawer').classList.add('open');
  $('#scrim').classList.add('open');
}

function dField(name, label, type, value, options) {
  if (type === 'select') {
    return '<label class="field"><span>' + esc(label) + '</span>'
      + '<select id="d-' + name + '">'
      + options.map((o) => '<option' + (o === value ? ' selected' : '') + '>'
        + esc(o) + '</option>').join('')
      + '</select></label>';
  }
  return '<label class="field"><span>' + esc(label) + '</span>'
    + '<input type="' + type + '" id="d-' + name + '" value="' + esc(value || '') + '"></label>';
}

function closeDrawer() {
  $('#drawer').classList.remove('open');
  $('#scrim').classList.remove('open');
  state.editing = null;
}

$('#dw-close').addEventListener('click', closeDrawer);
$('#scrim').addEventListener('click', closeDrawer);
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') closeDrawer();
});

$('#dw-save').addEventListener('click', async () => {
  if (!state.editing) return;
  const fields = ['status', 'deadline', 'company', 'title', 'city', 'track',
    'applied_at', 'assess_at', 'interview_at', 'company_type', 'next_action',
    'url', 'note'];
  const payload = {};
  fields.forEach((name) => {
    const el = $('#d-' + name);
    if (el) payload[name] = el.value;
  });
  try {
    await patch('/api/jobs/' + state.editing.id, payload);
    toast('已保存');
    closeDrawer();
    render();
  } catch (err) { toast(err.message, true); }
});

$('#dw-delete').addEventListener('click', async () => {
  if (!state.editing) return;
  if (!confirm('删除「' + state.editing.company + ' ' + state.editing.title + '」？删了就没了。')) return;
  try {
    await del('/api/jobs/' + state.editing.id);
    toast('已删除');
    closeDrawer();
    render();
  } catch (err) { toast(err.message, true); }
});

/* ------------------------------------------------------------ 启动 */

render();
