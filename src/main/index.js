'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');

const { scanPaths } = require('./scanner');
const { compressToBuffer, makeThumb, outputExtFor } = require('./compressor');
const { IMAGE_EXTS } = require('./formats');

const isMac = process.platform === 'darwin';
const DEFAULT_SETTINGS = {
  mode: 'smart',
  level: 2,
  quality: 78,
  targetFormat: 'keep',
  maxWidth: 0,
  maxHeight: 0,
  keepMetadata: false,
  keepSmaller: true,
  suffix: '',
  overwrite: false,
  keepStructure: true,
  recursive: true,
  outDir: '',
  theme: 'light',
};

let win = null;
let settings = { ...DEFAULT_SETTINGS };
let settingsFile = '';
let cancelToken = 0;
const thumbCache = new Map();
const THUMB_LIMIT = 800;

/* ------------------------------------------------------------------ 设置 */

async function loadSettings() {
  settingsFile = path.join(app.getPath('userData'), 'settings.json');
  try {
    const raw = await fs.readFile(settingsFile, 'utf8');
    settings = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    settings = { ...DEFAULT_SETTINGS };
  }
  if (!settings.outDir) settings.outDir = path.join(app.getPath('pictures'), 'Squish');
  return settings;
}

async function saveSettings(patch) {
  settings = { ...settings, ...(patch || {}) };
  try {
    await fs.mkdir(path.dirname(settingsFile), { recursive: true });
    await fs.writeFile(settingsFile, JSON.stringify(settings, null, 2), 'utf8');
  } catch {
    /* 忽略写入失败 */
  }
  return settings;
}

/* ------------------------------------------------------------------ 窗口 */

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 960,
    minHeight: 620,
    show: false,
    backgroundColor: '#f5f6f7',
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    trafficLightPosition: isMac ? { x: 18, y: 19 } : undefined,
    titleBarOverlay: isMac
      ? undefined
      : { color: '#ffffff', symbolColor: '#5b6470', height: 56 },
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; });

  // 开发辅助：--shot=/path/out.png 截取界面后自动退出
  const shotArg = process.argv.find((a) => a.startsWith('--shot='));
  if (shotArg) {
    const target = shotArg.slice('--shot='.length);
    const openArg = process.argv.find((a) => a.startsWith('--open='));
    win.webContents.once('did-finish-load', async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const waitForDebug = `new Promise(function (resolve) {
        var n = 0;
        var timer = setInterval(function () {
          if (window.__squishDebug) { clearInterval(timer); resolve(true); }
          else if (++n > 80) { clearInterval(timer); resolve(false); }
        }, 100);
      })`;
      await wait(300);
      await win.webContents.executeJavaScript(waitForDebug).catch(() => {});
      if (openArg) {
        const dir = openArg.slice('--open='.length);
        await win.webContents
          .executeJavaScript(`window.__squishDebug.addPaths([${JSON.stringify(dir)}])`)
          .catch((e) => console.error('addPaths failed', e));
        await wait(1600);
      }
      if (process.argv.includes('--run')) {
        await win.webContents
          .executeJavaScript('window.__squishDebug.start()')
          .catch((e) => console.error('start failed', e));
        await wait(4500);
      }
      await wait(500);
      const img = await win.webContents.capturePage();
      await fs.writeFile(target, img.toPNG()).catch(() => {});
      app.quit();
    });
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  if (process.argv.includes('--dev')) win.webContents.openDevTools({ mode: 'detach' });
}

function buildMenu() {
  const send = (cmd) => () => win && win.webContents.send('app:command', cmd);
  const template = [
    ...(isMac
      ? [{
          label: app.name,
          submenu: [
            { role: 'about', label: '关于 Squish' },
            { type: 'separator' },
            { role: 'hide', label: '隐藏' },
            { role: 'hideOthers', label: '隐藏其他' },
            { role: 'unhide', label: '显示全部' },
            { type: 'separator' },
            { role: 'quit', label: '退出 Squish' },
          ],
        }]
      : []),
    {
      label: '文件',
      submenu: [
        { label: '添加图片…', accelerator: 'CmdOrCtrl+O', click: send('add-files') },
        { label: '添加文件夹…', accelerator: 'CmdOrCtrl+Shift+O', click: send('add-folder') },
        { type: 'separator' },
        { label: '开始压缩', accelerator: 'CmdOrCtrl+Return', click: send('start') },
        { label: '取消压缩', accelerator: 'Escape', click: send('cancel') },
        { type: 'separator' },
        { label: '打开输出文件夹', accelerator: 'CmdOrCtrl+Shift+F', click: send('open-output') },
        { label: '导出报告…', click: send('export-report') },
        { type: 'separator' },
        { label: '清空列表', click: send('clear') },
        ...(isMac ? [] : [{ type: 'separator' }, { role: 'quit', label: '退出' }]),
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    { role: 'window', label: '窗口', submenu: [{ role: 'minimize', label: '最小化' }, { role: 'zoom', label: '缩放' }, { role: 'close', label: '关闭' }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ------------------------------------------------------------------ 压缩队列 */

function uniqueOutPath(item, options, outDir, used) {
  const targetFormat = options.overwrite ? 'keep' : options.targetFormat;
  const inExt = path.extname(item.path);
  const outExt = outputExtFor(inExt.toLowerCase(), targetFormat);
  const base = path.basename(item.path, inExt) + (options.suffix || '');

  let dir;
  if (options.overwrite) dir = path.dirname(item.path);
  else if (options.keepStructure) dir = path.join(outDir, path.dirname(item.rel || '.'));
  else dir = outDir;

  let candidate = path.join(dir, base + outExt);
  let n = 2;
  while (used.has(candidate) || (!options.overwrite && candidate === item.path)) {
    candidate = path.join(dir, `${base} (${n})${outExt}`);
    n += 1;
  }
  used.add(candidate);
  return candidate;
}

async function writeOut(outPath, buffer, stat) {
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  const tmp = `${outPath}.squish-tmp`;
  await fs.writeFile(tmp, buffer);
  if (process.platform === 'win32') await fs.rm(outPath, { force: true }).catch(() => {});
  await fs.rename(tmp, outPath);
  try {
    await fs.utimes(outPath, stat.atime, stat.mtime);
  } catch {
    /* 忽略 */
  }
}

ipcMain.handle('compress:start', async (event, payload) => {
  const options = { ...settings, ...(payload && payload.options) };
  const items = (payload && payload.items) || [];
  if (!items.length) return { ok: false, reason: 'empty' };

  const sender = event.sender;
  const token = ++cancelToken;
  const outDir = options.overwrite
    ? ''
    : path.resolve(options.outDir || path.join(app.getPath('pictures'), 'Squish'));

  if (!options.overwrite) await fs.mkdir(outDir, { recursive: true }).catch(() => {});

  const used = new Set();
  const summary = {
    ok: true,
    outDir,
    total: items.length,
    done: 0,
    skipped: 0,
    failed: 0,
    sizeIn: 0,
    sizeOut: 0,
    cancelled: false,
  };

  let cursor = 0;
  const concurrency = Math.max(2, Math.min(4, os.cpus().length - 1 || 2));

  const worker = async () => {
    for (;;) {
      if (token !== cancelToken) return;
      const index = cursor++;
      if (index >= items.length) return;
      const item = items[index];

      try {
        const stat = await fs.stat(item.path);
        const outPath = uniqueOutPath(item, options, outDir, used);
        const res = await compressToBuffer(item.path, options);
        const sizeOut = res.buffer ? res.buffer.length : stat.size;
        const sameFormat =
          path.extname(outPath).toLowerCase() === path.extname(item.path).toLowerCase();
        const noGain = res.skip || (options.keepSmaller && sizeOut >= stat.size && sameFormat);

        if (noGain) {
          summary.skipped += 1;
          summary.sizeIn += stat.size;
          summary.sizeOut += stat.size;
          sender.send('compress:progress', {
            id: item.id,
            status: 'skipped',
            sizeIn: stat.size,
            sizeOut: stat.size,
            outPath: item.path,
            note: res.note || '已是最优，保留原图',
            width: res.width,
            height: res.height,
          });
          continue;
        }

        await writeOut(outPath, res.buffer, stat);
        summary.done += 1;
        summary.sizeIn += stat.size;
        summary.sizeOut += sizeOut;
        sender.send('compress:progress', {
          id: item.id,
          status: 'done',
          sizeIn: stat.size,
          sizeOut,
          outPath,
          note: res.note,
          width: res.width,
          height: res.height,
          format: res.format,
        });
      } catch (err) {
        summary.failed += 1;
        sender.send('compress:progress', {
          id: item.id,
          status: 'error',
          note: (err && err.message) || '压缩失败',
        });
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));
  summary.cancelled = token !== cancelToken;
  return summary;
});

ipcMain.handle('compress:cancel', () => {
  cancelToken += 1;
  return true;
});

/* ------------------------------------------------------------------ 其它 IPC */

ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  platform: process.platform,
  arch: process.arch,
  pictures: app.getPath('pictures'),
  defaultOutDir: path.join(app.getPath('pictures'), 'Squish'),
  cpus: os.cpus().length,
  imageExts: [...IMAGE_EXTS].map((e) => e.slice(1)),
}));

ipcMain.handle('dialog:files', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: '选择图片',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '图片', extensions: [...IMAGE_EXTS].map((e) => e.slice(1)) }],
  });
  return res.canceled ? [] : res.filePaths;
});

ipcMain.handle('dialog:folder', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: '选择文件夹',
    properties: ['openDirectory', 'multiSelections', isMac ? 'treatPackageAsDirectory' : undefined].filter(Boolean),
  });
  return res.canceled ? [] : res.filePaths;
});

ipcMain.handle('dialog:outdir', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: '选择输出文件夹',
    defaultPath: settings.outDir,
    properties: ['openDirectory', 'createDirectory'],
  });
  if (res.canceled || !res.filePaths[0]) return null;
  await saveSettings({ outDir: res.filePaths[0] });
  return res.filePaths[0];
});

ipcMain.handle('scan:paths', async (_e, payload) => {
  const { paths, recursive, exclude } = payload || {};
  return scanPaths(paths || [], { recursive, exclude });
});

ipcMain.handle('thumb:get', async (_e, filePath) => {
  const key = String(filePath);
  if (thumbCache.has(key)) return thumbCache.get(key);
  const data = await makeThumb(key, 64);
  if (thumbCache.size > THUMB_LIMIT) thumbCache.clear();
  thumbCache.set(key, data);
  return data;
});

ipcMain.handle('shell:reveal', async (_e, target) => {
  try {
    const st = await fs.stat(target);
    if (st.isDirectory()) await shell.openPath(target);
    else shell.showItemInFolder(target);
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle('shell:open', async (_e, target) => {
  const err = await shell.openPath(target);
  return err || '';
});

ipcMain.handle('settings:get', () => settings);
ipcMain.handle('settings:set', (_e, patch) => saveSettings(patch));

ipcMain.handle('report:csv', async (_e, rows) => {
  const res = await dialog.showSaveDialog(win, {
    title: '导出压缩报告',
    defaultPath: path.join(app.getPath('desktop'), `Squish-报告-${Date.now()}.csv`),
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });
  if (res.canceled || !res.filePath) return null;
  const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const header = ['文件名', '原始大小(字节)', '压缩后(字节)', '节省', '状态', '输出路径'];
  const lines = [header.map(esc).join(',')];
  for (const r of rows || []) {
    lines.push([
      r.name, r.sizeIn, r.sizeOut, r.saved, r.status, r.outPath,
    ].map(esc).join(','));
  }
  // BOM 让 Excel 正确识别 UTF-8
  await fs.writeFile(res.filePath, '\ufeff' + lines.join('\r\n'), 'utf8');
  return res.filePath;
});

/* ------------------------------------------------------------------ 生命周期 */

app.whenReady().then(async () => {
  await loadSettings();
  buildMenu();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (!isMac) app.quit();
});
