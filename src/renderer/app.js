'use strict';

const $ = (sel) => document.querySelector(sel);
const api = window.squish;

const LEVELS = {
  1: { jpeg: 88, webp: 90, avif: 66, png: '256 色' },
  2: { jpeg: 78, webp: 82, avif: 55, png: '256 色' },
  3: { jpeg: 62, webp: 68, avif: 42, png: '128 色' },
};

const MODE_HINT = {
  smart: '视觉无损：肉眼几乎看不出差别，压缩率最高。',
  lossless: '像素完全不变：JPEG 只剥离元数据段，PNG/WebP/AVIF 走无损重编码。',
  custom: '手动指定质量参数，按需平衡体积与画质。',
};

const state = {
  items: [],
  byId: new Map(),
  rows: new Map(),
  info: null,
  running: false,
  theme: 'light',
  outDir: '',
  runTotal: 0,
  processed: 0,
  listCap: 3000,
  lastOutDir: '',
};

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

/* ------------------------------------------------------------------ 工具 */

function fmtBytes(n) {
  if (n == null || Number.isNaN(n)) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)} ${units[i]}`;
}

function fmtPct(a, b) {
  if (!a) return '0%';
  return `${Math.max(0, Math.round((1 - b / a) * 100))}%`;
}

function shortenPath(p, max = 52) {
  const s = String(p || '');
  return s.length > max ? `…${s.slice(-(max - 1))}` : s;
}

let toastTimer = null;
function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast is-on${isErr ? ' err' : ''}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.className = 'toast';
    setTimeout(() => { t.hidden = true; }, 220);
  }, isErr ? 4200 : 2400);
}

/* ------------------------------------------------------------------ 设置读写 */

function collectOptions() {
  return {
    mode: activeSeg('#modeGroup', 'mode') || 'smart',
    level: Number(activeSeg('#levelGroup', 'level')) || 2,
    quality: Number($('#quality').value) || 78,
    targetFormat: $('#targetFormat').value,
    maxWidth: Number($('#maxW').value) || 0,
    maxHeight: Number($('#maxH').value) || 0,
    keepMetadata: $('#keepMetadata').checked,
    keepSmaller: $('#keepSmaller').checked,
    suffix: $('#suffix').value.trim(),
    overwrite: $('#overwrite').checked,
    keepStructure: $('#keepStructure').checked,
    recursive: $('#recursive').checked,
    outDir: state.outDir,
    theme: state.theme,
  };
}

function activeSeg(sel, key) {
  const btn = $(`${sel} .seg-btn.is-on`);
  return btn ? btn.dataset[key] : null;
}

function setSeg(sel, key, value) {
  document.querySelectorAll(`${sel} .seg-btn`).forEach((b) => {
    b.classList.toggle('is-on', String(b.dataset[key]) === String(value));
  });
}

function syncModeUI() {
  const mode = activeSeg('#modeGroup', 'mode') || 'smart';
  $('#modeHint').textContent = MODE_HINT[mode];
  $('#levelWrap').hidden = mode !== 'smart';
  $('#qualityWrap').hidden = mode !== 'custom';

  const level = Number(activeSeg('#levelGroup', 'level')) || 2;
  const lv = LEVELS[level];
  $('#levelHint').textContent = `JPEG ${lv.jpeg} · WebP ${lv.webp} · AVIF ${lv.avif} · PNG ${lv.png}`;

  const q = Number($('#quality').value) || 78;
  $('#qualityVal').textContent = q;
  $('#qualityHint').textContent =
    `JPEG ${q} · WebP ${Math.min(100, q + 5)} · AVIF ${Math.round(q * 0.68)}`;
}

function syncOverwriteUI() {
  const on = $('#overwrite').checked;
  $('#targetFormat').disabled = on;
  $('#outDirBox').classList.toggle('is-off', on);
  $('#overwriteHint').hidden = !on;
}

function applySettings(s) {
  state.theme = s.theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = state.theme;
  $('#themeIcon').setAttribute(
    'd',
    state.theme === 'dark'
      ? 'M10 3.2a6.8 6.8 0 1 0 0 13.6 6.8 6.8 0 0 0 0-13.6Zm0 0v13.6'
      : 'M10 6.2a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6ZM10 1.6v1.8M10 16.6v1.8M1.6 10h1.8M16.6 10h1.8M3.9 3.9l1.3 1.3M14.8 14.8l1.3 1.3M16.1 3.9l-1.3 1.3M5.2 14.8l-1.3 1.3'
  );

  setSeg('#modeGroup', 'mode', s.mode || 'smart');
  setSeg('#levelGroup', 'level', s.level || 2);
  $('#quality').value = s.quality || 78;
  $('#targetFormat').value = s.targetFormat || 'keep';
  $('#maxW').value = s.maxWidth || '';
  $('#maxH').value = s.maxHeight || '';
  $('#keepMetadata').checked = Boolean(s.keepMetadata);
  $('#keepSmaller').checked = s.keepSmaller !== false;
  $('#overwrite').checked = Boolean(s.overwrite);
  $('#keepStructure').checked = s.keepStructure !== false;
  $('#recursive').checked = s.recursive !== false;
  $('#suffix').value = s.suffix || '';
  state.outDir = s.outDir || '';
  $('#outDirText').textContent = state.outDir;
  $('#outDirText').title = state.outDir;

  syncModeUI();
  syncOverwriteUI();
}

let persistTimer = null;
function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    api.setSettings(collectOptions()).catch(() => {});
  }, 250);
  updateFooter();
}

/* ------------------------------------------------------------------ 列表渲染 */

function createRow(item) {
  const row = el('div', 'row');
  row.dataset.id = item.id;

  const cell = el('div', 'filecell');
  const thumb = el('div', 'thumb');
  const meta = el('div', 'filemeta');
  const fname = el('div', 'fname', item.name);
  fname.title = item.path;
  const fpath = el('div', 'fpath', shortenPath(item.rel && item.rel !== item.name ? item.rel : item.root));
  meta.append(fname, fpath);
  cell.append(thumb, meta);

  const sizeIn = el('div', 'size', fmtBytes(item.size));
  const sizeOut = el('div', 'size out pending', '—');
  const save = el('div', 'savepill zero', '—');
  const badge = el('div', 'badge');
  const act = el('button', 'row-act');
  act.title = '打开所在文件夹';
  act.innerHTML = '<svg viewBox="0 0 20 20" class="ico" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h2.7c.4 0 .78.16 1.06.44L9.6 6.8h5.9A1.5 1.5 0 0 1 17 8.3v6.2a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 14.5v-8Z"/></svg>';
  act.addEventListener('click', () => api.reveal(item.outPath || item.path));

  row.append(cell, sizeIn, sizeOut, save, badge, act);
  row._refs = { thumb, sizeOut, save, badge, fname };
  row._item = item;

  // 缩略图懒加载
  if (state.thumbObserver) state.thumbObserver.observe(row);
  return row;
}

function paintThumb(row) {
  const item = row._item;
  const box = row._refs.thumb;
  box.textContent = '';
  const ext = (item.ext || '').replace('.', '').toUpperCase() || 'IMG';
  const fallback = el('span', 'ext', ext.slice(0, 4));
  box.append(fallback);
  api.thumb(item.path).then((data) => {
    if (!data) return;
    const img = new Image();
    img.src = data;
    img.alt = '';
    img.onload = () => { box.textContent = ''; box.append(img); };
  }).catch(() => {});
}

function setBadge(row, item) {
  const badge = row._refs.badge;
  badge.textContent = '';
  badge.className = 'badge';
  const map = {
    idle: ['等待', ''],
    queued: ['排队', ''],
    running: ['压缩中', 'running'],
    done: ['完成', 'done'],
    skipped: ['保留原图', 'skipped'],
    error: ['失败', 'error'],
  };
  const [text, cls] = map[item.status] || map.idle;
  if (cls) badge.classList.add(cls);
  if (item.status === 'running') {
    const dot = el('span', 'dot');
    badge.append(dot, document.createTextNode(text));
  } else {
    badge.textContent = text;
  }
  badge.title = item.note || (item.outPath && item.status !== 'error' ? item.outPath : '');
}

function updateRow(item) {
  const row = state.rows.get(item.id);
  if (!row) return;
  const r = row._refs;

  if (item.sizeOut != null) {
    r.sizeOut.textContent = fmtBytes(item.sizeOut);
    r.sizeOut.classList.remove('pending');
    const pct = item.size > 0 ? Math.round((1 - item.sizeOut / item.size) * 100) : 0;
    if (item.status === 'skipped' || pct <= 0) {
      r.save.textContent = item.status === 'skipped' ? '不变' : `${pct}%`;
      r.save.className = 'savepill zero';
    } else {
      r.save.textContent = `-${pct}%`;
      r.save.className = 'savepill';
    }
  } else {
    r.sizeOut.textContent = '—';
    r.sizeOut.classList.add('pending');
    r.save.textContent = '—';
    r.save.className = 'savepill zero';
  }
  setBadge(row, item);
}

function renderList() {
  const list = $('#list');
  list.textContent = '';
  state.rows.clear();

  const shown = state.items.slice(0, state.listCap);
  const frag = document.createDocumentFragment();
  for (const item of shown) {
    const row = createRow(item);
    state.rows.set(item.id, row);
    frag.append(row);
  }
  list.append(frag);

  const note = $('#listNote');
  if (state.items.length > state.listCap) {
    note.hidden = false;
    note.textContent = `列表仅显示体积最大的 ${state.listCap} 项，压缩时会处理全部 ${state.items.length} 张。`;
  } else {
    note.hidden = true;
  }

  for (const item of shown) updateRow(item);
  updateVisibility();
}

function updateVisibility() {
  const has = state.items.length > 0;
  $('#empty').hidden = has;
  $('#listwrap').hidden = !has;
  $('#stats').hidden = !has;
  $('#dropzone').hidden = !has;
  $('#btnClear').hidden = !has || state.running;
}

function updateStats() {
  const total = state.items.length;
  if (!total) {
    $('#statCount').textContent = '0';
    $('#statIn').textContent = '0 B';
    $('#statOut').textContent = '—';
    $('#statSaved').textContent = '—';
    $('#statSavedSub').textContent = '';
    $('#statProgress').textContent = '0 / 0';
    return;
  }
  let inSum = 0;
  let outSum = 0;
  let processed = 0;
  for (const i of state.items) {
    inSum += i.size || 0;
    if (i.status === 'done' || i.status === 'skipped') {
      processed += 1;
      outSum += i.sizeOut != null ? i.sizeOut : i.size || 0;
    }
  }
  $('#statCount').textContent = String(total);
  $('#statIn').textContent = fmtBytes(inSum);
  $('#statOut').textContent = processed ? fmtBytes(outSum) : '—';
  if (processed) {
    const saved = Math.max(0, inSum - outSum);
    $('#statSaved').textContent = fmtBytes(saved);
    $('#statSavedSub').textContent = processed === total ? `共省 ${fmtPct(inSum, outSum)}` : `${processed} 张已处理`;
  } else {
    $('#statSaved').textContent = '—';
    $('#statSavedSub').textContent = '';
  }
  const runTotal = state.running ? state.runTotal : total;
  $('#statProgress').textContent = `${processed} / ${runTotal}`;
}

function updateFooter() {
  const total = state.items.length;
  const sum = $('#abSum');
  const startBtn = $('#btnStart');

  if (!total) {
    sum.textContent = '还没有选择图片';
  } else if (state.running) {
    sum.textContent = `正在压缩 ${state.processed} / ${state.runTotal}…`;
  } else {
    let inSum = 0;
    let outSum = 0;
    let processed = 0;
    for (const i of state.items) {
      inSum += i.size || 0;
      if (i.status === 'done' || i.status === 'skipped') {
        processed += 1;
        outSum += i.sizeOut != null ? i.sizeOut : i.size || 0;
      }
    }
    const base = `${total} 张 · 原始 ${fmtBytes(inSum)}`;
    sum.textContent = processed
      ? `${base} · 压缩后 ${fmtBytes(outSum)} · 省 ${fmtBytes(Math.max(0, inSum - outSum))}（${fmtPct(inSum, outSum)}）`
      : base;
  }

  startBtn.disabled = state.running || total === 0;
  const allDone = total > 0 && state.items.every((i) => i.status === 'done' || i.status === 'skipped');
  $('#btnStartText').textContent = state.running ? '压缩中…' : allDone ? '重新压缩' : '开始压缩';
  $('#btnCancel').hidden = !state.running;
  $('#btnClear').hidden = !total || state.running;
  $('#abProgress').classList.toggle('is-on', state.running);
  if (state.running) {
    const pct = state.runTotal ? (state.processed / state.runTotal) * 100 : 0;
    $('#abProgressBar').style.width = `${Math.min(100, pct)}%`;
  } else if (state.processed && state.runTotal && state.processed >= state.runTotal) {
    $('#abProgressBar').style.width = '100%';
  } else {
    $('#abProgressBar').style.width = '0%';
  }
  const hasOut = Boolean(state.lastOutDir) && total > 0;
  $('#btnOpenOut').hidden = !hasOut;
  $('#btnReport').hidden = !state.items.some((i) => i.status === 'done' || i.status === 'skipped');
}

/* ------------------------------------------------------------------ 添加文件 */

async function addPaths(paths) {
  if (!paths || !paths.length || state.running) return;
  const options = collectOptions();
  let res;
  try {
    res = await api.scan(paths, {
      recursive: options.recursive,
      exclude: options.overwrite ? [] : [state.outDir],
    });
  } catch (e) {
    toast('读取失败：' + e.message, true);
    return;
  }

  const fresh = (res.items || []).filter((i) => !state.byId.has(i.id));
  if (!fresh.length) {
    toast(res.items && res.items.length ? '这些图片已经在列表里了' : '没有找到可压缩的图片');
    return;
  }

  for (const it of fresh) {
    const item = {
      ...it,
      status: 'idle',
      sizeOut: null,
      outPath: null,
      note: '',
    };
    state.items.push(item);
    state.byId.set(item.id, item);
  }
  state.items.sort((a, b) => b.size - a.size || a.name.localeCompare(b.name));
  renderList();
  updateStats();
  updateFooter();

  if (res.truncated) toast(`文件较多，本次最多加载 ${res.items.length} 张`);
  else toast(`已添加 ${fresh.length} 张图片`);
}

async function addFiles() {
  const paths = await api.pickFiles();
  await addPaths(paths);
}

async function addFolder() {
  const paths = await api.pickFolder();
  await addPaths(paths);
}

/* ------------------------------------------------------------------ 压缩 */

async function start() {
  if (state.running || !state.items.length) return;
  let targets = state.items.filter((i) => i.status !== 'done' && i.status !== 'skipped');
  if (!targets.length) targets = state.items.slice();

  const options = collectOptions();
  api.setSettings(options).catch(() => {});

  state.running = true;
  state.runTotal = targets.length;
  state.processed = 0;
  for (const t of targets) {
    t.status = 'queued';
    t.sizeOut = null;
    t.note = '';
    updateRow(t);
  }
  updateStats();
  updateFooter();
  updateVisibility();

  try {
    const summary = await api.start({
      items: targets.map((i) => ({ id: i.id, path: i.path, rel: i.rel })),
      options,
    });
    if (summary && summary.ok) {
      state.lastOutDir = summary.outDir || '';
      if (summary.cancelled) toast('已取消，已完成的文件已保存');
      else if (summary.failed) toast(`完成：成功 ${summary.done}，跳过 ${summary.skipped}，失败 ${summary.failed}`, true);
      else toast(`完成：${summary.done} 张已压缩，${summary.skipped} 张保留原图`);
    }
  } catch (e) {
    toast('压缩失败：' + e.message, true);
  } finally {
    state.running = false;
    for (const i of state.items) {
      if (i.status === 'queued' || i.status === 'running') {
        i.status = 'idle';
        updateRow(i);
      }
    }
    updateStats();
    updateFooter();
    updateVisibility();
  }
}

async function cancel() {
  if (!state.running) return;
  await api.cancel();
  toast('正在停止…');
}

/* ------------------------------------------------------------------ 事件绑定 */

function wire() {
  $('#btnAddFiles').addEventListener('click', addFiles);
  $('#btnEmptyFiles').addEventListener('click', addFiles);
  $('#btnAddFolder').addEventListener('click', addFolder);
  $('#btnEmptyFolder').addEventListener('click', addFolder);
  $('#dropzone').addEventListener('click', addFiles);

  $('#btnTheme').addEventListener('click', () => {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    applySettings(collectOptions());
    persist();
  });

  document.querySelectorAll('#modeGroup .seg-btn').forEach((b) => {
    b.addEventListener('click', () => {
      setSeg('#modeGroup', 'mode', b.dataset.mode);
      syncModeUI();
      persist();
    });
  });
  document.querySelectorAll('#levelGroup .seg-btn').forEach((b) => {
    b.addEventListener('click', () => {
      setSeg('#levelGroup', 'level', b.dataset.level);
      syncModeUI();
      persist();
    });
  });

  $('#quality').addEventListener('input', () => { syncModeUI(); persist(); });
  ['#targetFormat', '#maxW', '#maxH', '#keepMetadata', '#keepSmaller', '#suffix', '#keepStructure', '#recursive'].forEach((sel) => {
    $(sel).addEventListener('change', () => { syncOverwriteUI(); persist(); });
  });
  $('#overwrite').addEventListener('change', () => { syncOverwriteUI(); persist(); });

  $('#btnReset').addEventListener('click', () => {
    applySettings({
      mode: 'smart', level: 2, quality: 78, targetFormat: 'keep',
      maxWidth: 0, maxHeight: 0, keepMetadata: false, keepSmaller: true,
      overwrite: false, keepStructure: true, recursive: true, suffix: '',
      outDir: state.outDir, theme: state.theme,
    });
    persist();
    toast('已恢复默认设置');
  });

  $('#btnOutDir').addEventListener('click', async () => {
    const dir = await api.pickOutDir();
    if (dir) {
      state.outDir = dir;
      $('#outDirText').textContent = dir;
      $('#outDirText').title = dir;
      persist();
    }
  });

  $('#btnStart').addEventListener('click', start);
  $('#btnCancel').addEventListener('click', cancel);
  $('#btnClear').addEventListener('click', () => {
    if (state.running) return;
    state.items = [];
    state.byId.clear();
    renderList();
    state.processed = 0;
    state.runTotal = 0;
    updateStats();
    updateFooter();
    updateVisibility();
  });

  $('#btnOpenOut').addEventListener('click', () => {
    const dir = state.lastOutDir || state.outDir;
    if (dir) api.openPath(dir);
  });

  $('#btnReport').addEventListener('click', async () => {
    const rows = state.items
      .filter((i) => i.status === 'done' || i.status === 'skipped')
      .map((i) => ({
        name: i.rel || i.name,
        sizeIn: i.size,
        sizeOut: i.sizeOut,
        saved: i.size ? `${Math.round((1 - (i.sizeOut || i.size) / i.size) * 100)}%` : '',
        status: i.status === 'done' ? '已压缩' : '保留原图',
        outPath: i.outPath || '',
      }));
    if (!rows.length) return;
    const file = await api.exportReport(rows);
    if (file) toast('报告已保存');
  });

  api.onProgress((p) => {
    const item = state.byId.get(p.id);
    if (!item) return;
    item.status = p.status;
    if (p.sizeOut != null) item.sizeOut = p.sizeOut;
    if (p.outPath) item.outPath = p.outPath;
    if (p.note) item.note = p.note;
    state.processed += 1;
    updateRow(item);
    updateStats();
    updateFooter();
    if (p.status === 'error' && p.note) toast(`「${item.name}」压缩失败：${p.note}`, true);
  });

  api.onCommand((cmd) => {
    if (cmd === 'add-files') addFiles();
    else if (cmd === 'add-folder') addFolder();
    else if (cmd === 'start') start();
    else if (cmd === 'cancel') cancel();
    else if (cmd === 'clear') { if (!state.running) $('#btnClear').click(); }
    else if (cmd === 'open-output') $('#btnOpenOut').click();
    else if (cmd === 'export-report') $('#btnReport').click();
  });

  // 拖拽
  let depth = 0;
  const overlay = $('#dragOverlay');
  const showOverlay = () => { overlay.hidden = false; };
  const hideOverlay = () => { overlay.hidden = true; $('#dropzone').classList.remove('is-over'); };

  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    depth += 1;
    if (state.running) return;
    showOverlay();
    $('#dropzone').classList.add('is-over');
  });
  window.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', (e) => {
    e.preventDefault();
    depth = Math.max(0, depth - 1);
    if (depth === 0) hideOverlay();
  });
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    depth = 0;
    hideOverlay();
    if (state.running) { toast('压缩进行中，请稍后再添加'); return; }
    const files = Array.from(e.dataTransfer ? e.dataTransfer.files : []);
    const paths = files.map((f) => api.pathForFile(f)).filter(Boolean);
    if (paths.length) await addPaths(paths);
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.running) cancel();
  });

  // 缩略图懒加载
  state.thumbObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const row = entry.target;
      state.thumbObserver.unobserve(row);
      paintThumb(row);
    }
  }, { root: $('#list'), rootMargin: '160px' });
}

/* ------------------------------------------------------------------ 启动 */

(async function init() {
  try {
    state.info = await api.info();
  } catch {
    state.info = { platform: 'darwin', defaultOutDir: '' };
  }
  document.body.dataset.platform = state.info.platform;
  if (state.info.platform === 'win32') {
    document.querySelectorAll('.empty-tip').forEach((n) => {
      n.innerHTML = '也可以按 <kbd>Ctrl</kbd> <kbd>O</kbd> 选择图片';
    });
  }

  let settings;
  try {
    settings = await api.getSettings();
  } catch {
    settings = {};
  }
  applySettings({
    mode: 'smart', level: 2, quality: 78, targetFormat: 'keep',
    keepSmaller: true, keepStructure: true, recursive: true,
    outDir: state.info.defaultOutDir || '',
    ...settings,
  });

  wire();
  updateStats();
  updateFooter();
  updateVisibility();

  // 调试入口（仅用于自动化截图/联调）
  window.__squishDebug = { addPaths, start, state };
}());
