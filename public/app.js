const $ = (s) => document.querySelector(s);
const selected = new Set();

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// One place that turns network/HTTP failures into something readable. A thrown
// fetch() (server down, connection dropped) becomes an actionable message
// instead of the browser's bare "Failed to fetch".
async function api(path, options) {
  let res;
  try {
    res = await fetch(path, options);
  } catch {
    const err = new Error("Can't reach the server. Make sure it's running, then reload the page.");
    err.offline = true;
    throw err;
  }
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function showMessage(text) {
  const out = $('#out');
  out.removeAttribute('aria-busy');
  out.textContent = '';
  const c = el('div', 'card');
  c.append(el('p', 'err', text));
  out.append(c);
}

// Spinner + skeleton shown while the model is working, mirroring the real layout.
function showLoading() {
  const out = $('#out');
  out.setAttribute('aria-busy', 'true');
  out.textContent = '';

  const status = el('div', 'loading');
  const spin = el('div', 'spinner');
  spin.setAttribute('aria-hidden', 'true');
  const text = el('p', 'loading-text', 'Analyzing your plate…');
  const s = liveSettings();
  const p = providerFor(s.provider);
  text.append(el('span', 'loading-sub', p ? [p.label, s.model || p.model].filter(Boolean).join(' · ') : 'Contacting the model'));
  status.append(spin, text);

  const summary = el('div', 'card sk-card');
  summary.append(el('div', 'sk sk-ring'));
  const lines = el('div', 'sk-lines');
  for (const w of ['w70', 'w95', 'w45']) lines.append(el('div', 'sk sk-line ' + w));
  summary.append(lines);

  const totals = el('div', 'card');
  const grid = el('div', 'sk-grid');
  for (let i = 0; i < 8; i++) grid.append(el('div', 'sk sk-box'));
  totals.append(grid);

  out.append(status, summary, totals);
}

async function loadConditions() {
  const list = await api('/api/conditions');
  for (const c of list) {
    const b = el('button', 'chip', c.label);
    b.type = 'button';
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => {
      selected.has(c.id) ? selected.delete(c.id) : selected.add(c.id);
      b.setAttribute('aria-pressed', String(selected.has(c.id)));
    });
    $('#chips').append(b);
  }
}

// --- API settings (bring your own key) -------------------------------------
// Stored in this browser only; sent to the server just to run one analysis.
const SETTINGS_KEY = 'nutriplate:settings';
let providers = [];
let serverDefault = { provider: '', model: '' };

const readSettings = () => {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { return {}; }
};
const writeSettings = (s) => {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch {}
};
const liveSettings = () => ({
  provider: $('#provider').value,
  model: $('#model').value.trim(),
  apiKey: $('#apikey').value.trim(),
});
const providerFor = (id) => providers.find((p) => p.id === id);
const defaultModelFor = (id) => (id === serverDefault.provider ? serverDefault.model : providerFor(id)?.model) || '';

function renderStatus() {
  const s = liveSettings();
  const p = providerFor(s.provider);
  const node = $('#status');
  if (!p) { node.textContent = ''; return; }
  const model = s.model || p.model || '';
  if (s.apiKey) node.textContent = `Using your ${p.label} key · ${model}`;
  else if (p.serverKey) node.textContent = `Using this site's ${p.label} key · ${model}`;
  else if (!p.needsKey) node.textContent = `${p.label} needs no key · ${model}`;
  else node.textContent = `Add your ${p.label} API key to analyze meals.`;
}

const persist = () => {
  writeSettings(liveSettings());
  renderStatus();
};

async function initSettings() {
  const cfg = await api('/api/config');
  providers = cfg.providers || [];
  const sel = $('#provider');
  sel.textContent = '';
  for (const p of providers) sel.append(new Option(p.label, p.id));

  serverDefault = { provider: cfg.defaultProvider, model: cfg.defaultModel };
  const saved = readSettings();
  const active = providerFor(saved.provider) || providerFor(cfg.defaultProvider) || providers[0];
  if (active) sel.value = active.id;
  $('#model').value = saved.provider === sel.value && saved.model ? saved.model : defaultModelFor(sel.value);
  $('#apikey').value = saved.apiKey || '';
  renderStatus();

  sel.addEventListener('change', () => {
    const s = readSettings();
    $('#model').value = s.provider === sel.value && s.model ? s.model : defaultModelFor(sel.value);
    persist();
  });
  $('#model').addEventListener('input', persist);
  $('#apikey').addEventListener('input', persist);
  $('#clearSettings').addEventListener('click', () => {
    writeSettings({});
    $('#apikey').value = '';
    $('#model').value = defaultModelFor(sel.value);
    renderStatus();
  });
}

// --- Results ---------------------------------------------------------------
const COLORS = { carbs: '#e0a030', protein: '#1f7a6d', fat: '#d5644a' };

function macroRing(t) {
  const parts = [
    ['Carbs', t.carbs_g * 4, COLORS.carbs],
    ['Protein', t.protein_g * 4, COLORS.protein],
    ['Fat', t.fat_g * 9, COLORS.fat],
  ];
  const sum = parts.reduce((a, p) => a + p[1], 0) || 1;
  const NS = 'http://www.w3.org/2000/svg';
  const r = 60, C = 2 * Math.PI * r;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 150 150');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Calories from carbs, protein and fat');
  let offset = 0;
  const base = document.createElementNS(NS, 'circle');
  for (const [k, v] of Object.entries({ cx: 75, cy: 75, r, fill: 'none', stroke: '#e6ece9', 'stroke-width': 20 })) base.setAttribute(k, v);
  svg.append(base);
  for (const [, v, color] of parts) {
    const len = (v / sum) * C;
    const c = document.createElementNS(NS, 'circle');
    const attrs = { cx: 75, cy: 75, r, fill: 'none', stroke: color, 'stroke-width': 20, 'stroke-dasharray': `${len} ${C - len}`, 'stroke-dashoffset': -offset };
    for (const [k, val] of Object.entries(attrs)) c.setAttribute(k, val);
    svg.append(c);
    offset += len;
  }
  const wrap = el('div', 'ring');
  const mid = el('div', 'mid');
  mid.append(el('b', null, Math.round(t.calories)), el('span', null, 'kcal'));
  wrap.append(svg, mid);
  return wrap;
}

const LABELS = [
  ['carbs_g', 'Carbs', 'g'], ['sugar_g', 'Sugar', 'g'], ['fiber_g', 'Fiber', 'g'],
  ['protein_g', 'Protein', 'g'], ['fat_g', 'Fat', 'g'], ['sat_fat_g', 'Saturated fat', 'g'],
  ['cholesterol_mg', 'Cholesterol', 'mg'], ['sodium_mg', 'Sodium', 'mg'],
];
const round = (n) => Math.round(Number(n) || 0);

function render(d) {
  const out = $('#out');
  out.removeAttribute('aria-busy');
  out.textContent = '';

  if (!d.foods.length) {
    const c = el('div', 'card');
    c.append(el('p', null, d.verdict || 'No foods recognized. Try listing dishes such as "rice and lentil soup".'));
    out.append(c);
    return;
  }

  const t = d.totals;
  const s1 = el('div', 'card summary');
  const right = el('div');
  const band = d.score >= 70 ? 'good' : d.score >= 40 ? 'mid' : 'low';
  const sc = el('div', 'score ' + band);
  sc.append(el('b', null, String(d.score)), el('span', null, '/ 100 plate score'));
  const lg = el('div', 'legend');
  for (const [name, color] of [['Carbs', COLORS.carbs], ['Protein', COLORS.protein], ['Fat', COLORS.fat]]) {
    const i = el('i'); i.style.background = color;
    const s = el('span'); s.append(i, name); lg.append(s);
  }
  right.append(sc, el('p', null, d.verdict), lg);
  s1.append(macroRing(t), right);

  const s2 = el('div', 'card');
  s2.append(el('h2', null, 'Meal totals'));
  const grid = el('div', 'nut');
  for (const [k, label, u] of LABELS) {
    const c = el('div'); c.append(el('b', null, round(t[k]) + ' ' + u), el('span', null, label)); grid.append(c);
  }
  s2.append(grid);

  const s3 = el('div', 'card');
  s3.append(el('h2', null, 'Food by food'));
  for (const f of d.foods) {
    const item = el('article', 'food');
    const head = el('header');
    const nm = el('div'); nm.append(el('b', null, f.name), document.createTextNode(' '), el('span', 'amt', f.amount));
    const adv = ['ok', 'reduce', 'avoid'].includes(f.advice) ? f.advice : 'ok';
    head.append(nm, el('span', 'tag ' + adv, adv === 'ok' ? 'Good choice' : adv === 'reduce' ? 'Reduce' : 'Avoid'));
    item.append(head,
      el('p', 'macros', `${round(f.calories)} kcal · ${round(f.carbs_g)} g carbs · ${round(f.protein_g)} g protein · ${round(f.fat_g)} g fat`),
      el('p', 'port', 'Suggested: ' + f.suggested_portion),
      el('p', null, f.note));
    s3.append(item);
  }

  out.append(s1, s2, s3);
  for (const [title, arr] of [['Tips for this plate', d.tips], ['Better swaps', d.swaps]]) {
    if (!arr?.length) continue;
    const c = el('div', 'card'); c.append(el('h2', null, title));
    const ul = el('ul'); arr.forEach((x) => ul.append(el('li', null, x))); c.append(ul); out.append(c);
  }
}

$('#form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const foods = $('#foods').value.trim();
  if (!foods) { showMessage('Enter at least one food to analyze.'); return; }
  const btn = $('#go');
  btn.disabled = true; btn.textContent = 'Analyzing…'; btn.classList.add('is-loading');
  showLoading();
  persist();
  const s = liveSettings();
  const payload = { foods, conditions: [...selected] };
  if (s.provider) payload.provider = s.provider;
  if (s.model) payload.model = s.model;
  if (s.apiKey) payload.apiKey = s.apiKey;
  try {
    const data = await api('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    render(data);
  } catch (err) {
    if (/API settings/i.test(err.message)) $('#settings').open = true;
    showMessage(err.message);
  } finally {
    btn.disabled = false; btn.textContent = 'Analyze meal'; btn.classList.remove('is-loading');
  }
});

Promise.all([loadConditions(), initSettings()]).catch((err) => showMessage(err.message));
