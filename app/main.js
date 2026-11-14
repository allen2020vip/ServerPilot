'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, Tray, nativeImage, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Store = require('./src/store');
const ConnectionManager = require('./src/connection-manager');
const Deployer = require('./src/deployer');
const templates = require('./src/templates');
const { McpServer } = require('./src/mcp-server');
const { buildTools } = require('./src/mcp-tools');

let mainWindow = null;
let store = null;
let manager = null;
let deployer = null;
let mcp = null;
let mcpTools = null;
let tray = null;
let isQuitting = false;

const isDev = process.argv.includes('--dev');

/* 单实例：已经在托盘里跑时，再次启动只把窗口唤到前台 */
const hasSingleLock = app.requestSingleInstanceLock();
if (!hasSingleLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
}

/* ---------- 托盘 ---------- */
function showWindow() {
  if (!mainWindow) { createWindow(); return; }
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
}

function hideToTray() {
  if (!mainWindow) return;
  mainWindow.hide();
  if (!store.settings().trayTipShown) {
    store.setSetting('trayTipShown', true);
    try {
      tray.displayBalloon({
        title: 'ServerPilot 仍在后台运行',
        content: '已最小化到托盘。双击托盘图标可重新打开，右键图标可退出程序。'
      });
    } catch (_) {}
  }
}

function createTray() {
  if (tray) return;
  const iconPath = path.join(__dirname, 'build', 'icon.ico');
  let img = nativeImage.createFromPath(iconPath);
  if (img.isEmpty()) img = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png'));
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
  tray.setToolTip('ServerPilot · 服务器工作台');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 ServerPilot', click: () => showWindow() },
    { label: '新建连接', click: () => { showWindow(); if (mainWindow) mainWindow.webContents.send('tray:new-host'); } },
    { type: 'separator' },
    { label: '退出', click: () => { isQuitting = true; app.quit(); } }
  ]));
  tray.on('click', () => showWindow());
  tray.on('double-click', () => showWindow());
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1120,
    minHeight: 700,
    frame: false,
    show: false,
    backgroundColor: store.settings().theme === 'light' ? '#F4F6F9' : '#0B0C0F',
    title: 'ServerPilot',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });

  mainWindow.on('maximize', () => mainWindow.webContents.send('window:state', { maximized: true }));
  mainWindow.on('unmaximize', () => mainWindow.webContents.send('window:state', { maximized: false }));

  mainWindow.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.log('[renderer]', message);
  });
  mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
    console.error('[load-fail]', code, desc);
  });
  mainWindow.webContents.on('preload-error', (_e, p, err) => {
    console.error('[preload-error]', p, err && err.message);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // 关闭按钮 → 收进托盘；只有托盘「退出」或系统退出才真正关闭
  mainWindow.on('close', (e) => {
    if (isQuitting) return;
    e.preventDefault();
    hideToTray();
  });

  // 外链一律走系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  if (!hasSingleLock) return;
  Menu.setApplicationMenu(null);
  store = new Store(path.join(app.getPath('userData'), 'serverpilot.json'));
  manager = new ConnectionManager();
  deployer = new Deployer(manager);
  registerIpc();
  createWindow();
  createTray();

  if (store.settings().mcpEnabled !== false) {
    startMcp().catch((e) => console.error('[mcp]', e.message));
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else showWindow();
  });
});

app.on('window-all-closed', () => {
  if (isQuitting) {
    if (manager) manager.closeAll();
    app.quit();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  if (tray) { try { tray.destroy(); } catch (_) {} tray = null; }
  if (mcp) { try { mcp.stop(); } catch (_) {} }
  if (manager) manager.closeAll();
});

/* 关机 / 注销时允许正常结束，不被托盘拦截 */
app.on('session-end', () => { isQuitting = true; });

/* ------------------------------------------------------------------ */
/* MCP 服务                                                            */
/* ------------------------------------------------------------------ */

function mcpToken() {
  const s = store.settings();
  if (s.mcpToken) return s.mcpToken;
  const t = crypto.randomBytes(24).toString('hex');
  store.setSetting('mcpToken', t);
  return t;
}

function mcpReadonly() {
  const s = store.settings();
  return s.mcpReadonly !== false; // 默认只读，安全优先
}

function ensureMcp() {
  if (mcp) return mcp;
  mcpTools = buildTools({ store, manager, deployer, templates });
  mcp = new McpServer({
    tools: mcpTools,
    getToken: mcpToken,
    getReadonly: mcpReadonly,
    onLog: (entry) => send('mcp:log', entry)
  });
  return mcp;
}

async function startMcp() {
  const s = ensureMcp();
  const st = await s.start(store.settings().mcpPort || 8787);
  store.setSetting('mcpLastPort', st.port);
  store.setSetting('mcpEnabled', true);
  send('mcp:state', mcpInfo());
  return st;
}

async function stopMcp() {
  if (!mcp) {
    store.setSetting('mcpEnabled', false);
    return null;
  }
  await mcp.stop();
  store.setSetting('mcpEnabled', false);
  send('mcp:state', mcpInfo());
  return mcpInfo();
}

function mcpInfo() {
  ensureMcp();
  const s = store.settings();
  const st = mcp ? mcp.state() : { running: false, port: null, url: null, readonly: mcpReadonly(), toolCount: 0, calls: 0 };
  return {
    ...st,
    enabled: s.mcpEnabled !== false,
    configuredPort: s.mcpPort || 8787,
    token: mcpToken(),
    tools: mcpTools ? mcpTools.list() : [],
    readonly: mcpReadonly()
  };
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

const ok = (data) => ({ ok: true, data });
const fail = (err) => ({ ok: false, error: err && err.message ? err.message : String(err) });

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */

function registerIpc() {
  /* ---------- 窗口 ---------- */
  ipcMain.on('window:minimize', () => mainWindow && mainWindow.minimize());
  ipcMain.on('window:maximize', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipcMain.on('window:close', () => {
    if (!mainWindow) return;
    if (isQuitting) mainWindow.close();
    else hideToTray();
  });
  ipcMain.handle('window:isMaximized', () => !!mainWindow && mainWindow.isMaximized());

  /* ---------- 主机 ---------- */
  ipcMain.handle('hosts:list', () => {
    try { return ok(store.listHosts()); } catch (e) { return fail(e); }
  });

  ipcMain.handle('hosts:save', (e, host) => {
    try { return ok(store.saveHost(host)); } catch (e) { return fail(e); }
  });

  ipcMain.handle('hosts:delete', (e, id) => {
    try {
      manager.close(id);
      return ok(store.deleteHost(id));
    } catch (e) { return fail(e); }
  });

  ipcMain.handle('hosts:test', async (e, host) => {
    try {
      const resolved = store.resolveHostSecrets(host);
      const t0 = Date.now();
      await manager.testConnection(resolved);
      return ok({ latency: Date.now() - t0 });
    } catch (err) { return fail(err); }
  });

  /* ---------- 连接 ---------- */
  ipcMain.handle('conn:open', async (e, hostId) => {
    try {
      const host = store.getHostForConnect(hostId);
      if (!host) throw new Error('主机不存在');
      await manager.connect(host);
      return ok({ hostId });
    } catch (err) { return fail(err); }
  });

  ipcMain.handle('conn:close', (e, hostId) => {
    try { manager.close(hostId); return ok(true); } catch (err) { return fail(err); }
  });

  ipcMain.handle('conn:status', (e, hostId) => {
    const c = manager.get(hostId);
    return ok(c ? { connected: c.state === 'ready' } : { connected: false });
  });

  /* ---------- 收藏夹 ---------- */
  ipcMain.handle('favorites:list', () => {
    try { return ok(store.listFavorites()); } catch (e) { return fail(e); }
  });

  ipcMain.handle('favorites:add', (e, fav) => {
    try { return ok(store.addFavorite(fav || {})); } catch (e) { return fail(e); }
  });

  ipcMain.handle('favorites:remove', (e, id) => {
    try { return ok(store.removeFavorite(id)); } catch (e) { return fail(e); }
  });

  /* ---------- 终端 ---------- */
  const shells = new Map();

  ipcMain.handle('shell:open', async (e, { hostId, cols, rows, cwd }) => {
    try {
      const conn = await manager.connect(store.getHostForConnect(hostId));
      const channel = await conn.openShell({ cols: cols || 120, rows: rows || 32, cwd });
      const sid = `${hostId}:${Date.now().toString(36)}`;
      shells.set(sid, channel);
      channel.on('data', (data) => send('shell:data', { sid, data: data.toString('utf8') }));
      channel.stderr.on('data', (data) => send('shell:data', { sid, data: data.toString('utf8') }));
      channel.on('close', () => {
        send('shell:exit', { sid });
        shells.delete(sid);
      });
      return ok({ sid });
    } catch (err) { return fail(err); }
  });

  ipcMain.on('shell:write', (e, { sid, data }) => {
    const ch = shells.get(sid);
    if (ch) { try { ch.write(data); } catch (_) {} }
  });

  ipcMain.on('shell:resize', (e, { sid, cols, rows }) => {
    const ch = shells.get(sid);
    if (ch) { try { ch.setWindow(rows, cols, 0, 0); } catch (_) {} }
  });

  ipcMain.on('shell:close', (e, { sid }) => {
    const ch = shells.get(sid);
    if (ch) { try { ch.close(); } catch (_) {} shells.delete(sid); }
  });

  /* ---------- 文件 ---------- */
  ipcMain.handle('sftp:list', async (e, { hostId, dir }) => {
    try {
      const conn = await manager.connect(store.getHostForConnect(hostId));
      return ok(await conn.list(dir));
    } catch (err) { return fail(err); }
  });

  ipcMain.handle('sftp:home', async (e, { hostId }) => {
    try {
      const conn = await manager.connect(store.getHostForConnect(hostId));
      const home = await conn.realpath('.');
      return ok({ path: home });
    } catch (err) { return fail(err); }
  });

  ipcMain.handle('sftp:read', async (e, { hostId, file }) => {
    try {
      const conn = await manager.connect(store.getHostForConnect(hostId));
      return ok(await conn.readFile(file));
    } catch (err) { return fail(err); }
  });

  ipcMain.handle('sftp:save', async (e, { hostId, file, content, encoding }) => {
    try {
      const conn = await manager.connect(store.getHostForConnect(hostId));
      await conn.writeFile(file, content, encoding);
      return ok({ saved: true });
    } catch (err) { return fail(err); }
  });

  ipcMain.handle('sftp:mkdir', async (e, { hostId, dir }) => {
    try {
      const conn = await manager.connect(store.getHostForConnect(hostId));
      await conn.mkdir(dir);
      return ok(true);
    } catch (err) { return fail(err); }
  });

  ipcMain.handle('sftp:rename', async (e, { hostId, from, to }) => {
    try {
      const conn = await manager.connect(store.getHostForConnect(hostId));
      await conn.rename(from, to);
      return ok(true);
    } catch (err) { return fail(err); }
  });

  ipcMain.handle('sftp:delete', async (e, { hostId, targets }) => {
    try {
      const conn = await manager.connect(store.getHostForConnect(hostId));
      for (const t of targets) {
        await conn.remove(t.path, t.isDir);
        send('transfer:progress', { kind: 'delete', name: t.path, percent: 100 });
      }
      return ok(true);
    } catch (err) { return fail(err); }
  });

  ipcMain.handle('sftp:chmod', async (e, { hostId, file, mode }) => {
    try {
      const conn = await manager.connect(store.getHostForConnect(hostId));
      await conn.chmod(file, mode);
      return ok(true);
    } catch (err) { return fail(err); }
  });

  ipcMain.handle('sftp:upload', async (e, { hostId, localPaths, remoteDir }) => {
    try {
      const conn = await manager.connect(store.getHostForConnect(hostId));
      const results = [];
      for (const lp of localPaths) {
        const st = fs.statSync(lp);
        const name = path.basename(lp);
        const target = remoteDir.replace(/\/+$/, '') + '/' + name;
        const t0 = Date.now();
        if (st.isDirectory()) {
          await conn.uploadDir(lp, target, (p) => send('transfer:progress', p));
        } else {
          await conn.uploadFile(lp, target, (p) => send('transfer:progress', { ...p, name }));
        }
        results.push({ name, target, ms: Date.now() - t0 });
      }
      return ok(results);
    } catch (err) { return fail(err); }
  });

  ipcMain.handle('sftp:download', async (e, { hostId, remotePaths, localDir }) => {
    try {
      const conn = await manager.connect(store.getHostForConnect(hostId));
      const results = [];
      for (const rp of remotePaths) {
        const name = path.posix.basename(rp.replace(/\/+$/, ''));
        const target = path.join(localDir, name);
        const st = await conn.stat(rp);
        if (st.isDirectory()) {
          await conn.downloadDir(rp, target, (p) => send('transfer:progress', p));
        } else {
          await conn.downloadFile(rp, target, (p) => send('transfer:progress', { ...p, name }));
        }
        results.push({ name, target });
      }
      return ok(results);
    } catch (err) { return fail(err); }
  });

  ipcMain.handle('sftp:exists', async (e, { hostId, file }) => {
    try {
      const conn = await manager.connect(store.getHostForConnect(hostId));
      try { await conn.stat(file); return ok(true); } catch { return ok(false); }
    } catch (err) { return fail(err); }
  });

  /* ---------- 命令 / 部署 ---------- */
  const runs = new Map();

  ipcMain.handle('exec:run', async (e, { hostId, command, cwd, rid }) => {
    try {
      const conn = await manager.connect(store.getHostForConnect(hostId));
      const id = rid || `r${Date.now().toString(36)}`;
      runs.set(id, true);
      conn.execStream(command, cwd, (stream, chunk) => {
        if (runs.get(id) !== false) send('exec:output', { rid: id, stream, chunk });
      }).then((code) => {
        runs.delete(id);
        send('exec:done', { rid: id, code });
      }).catch((err) => {
        runs.delete(id);
        send('exec:done', { rid: id, code: -1, error: err.message });
      });
      return ok({ rid: id });
    } catch (err) { return fail(err); }
  });

  ipcMain.handle('exec:cancel', (e, { rid }) => {
    runs.set(rid, false);
    return ok(true);
  });

  ipcMain.handle('deploy:templates', () => ok(templates.list()));

  ipcMain.handle('deploy:run', async (e, { hostId, planId, values, privileged }) => {
    try {
      const conn = await manager.connect(store.getHostForConnect(hostId));
      const steps = templates.buildById(planId, values);
      await deployer.run(conn, { planId, steps, privileged }, {
        log: (entry) => send('deploy:log', { planId, ...entry }),
        progress: (p) => send('deploy:progress', { planId, ...p })
      });
      return ok(true);
    } catch (err) { return fail(err); }
  });

  /* ---------- 系统对话框 ---------- */
  ipcMain.handle('dialog:pickFiles', async () => {
    const r = await dialog.showOpenDialog(mainWindow, { properties: ['openFile', 'multiSelections'] });
    return ok(r.canceled ? [] : r.filePaths);
  });

  ipcMain.handle('dialog:pickFolder', async () => {
    const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
    return ok(r.canceled ? null : r.filePaths[0]);
  });

  ipcMain.handle('dialog:saveFile', async (e, { defaultName }) => {
    const r = await dialog.showSaveDialog(mainWindow, { defaultPath: defaultName });
    return ok(r.canceled ? null : r.filePath);
  });

  ipcMain.handle('shell:openLocal', async (e, { target }) => {
    try {
      if (target) shell.showItemInFolder(target);
      else shell.openPath(app.getPath('downloads'));
      return ok(true);
    } catch (err) { return fail(err); }
  });

  ipcMain.handle('app:paths', () => ok({ downloads: app.getPath('downloads'), userData: app.getPath('userData') }));

  ipcMain.handle('clipboard:write', (e, text) => {
    clipboard.writeText(String(text == null ? '' : text));
    return ok(true);
  });

  /* ---------- 主题 ---------- */
  ipcMain.on('theme:get', (e) => {
    e.returnValue = store.settings().theme === 'light' ? 'light' : 'dark';
  });

  ipcMain.handle('theme:set', (e, theme) => {
    try {
      const t = theme === 'light' ? 'light' : 'dark';
      store.setSetting('theme', t);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.setBackgroundColor(t === 'light' ? '#F4F6F9' : '#08090B');
      }
      return ok(t);
    } catch (err) { return fail(err); }
  });

  /* ---------- MCP ---------- */
  ipcMain.handle('mcp:info', () => ok(mcpInfo()));

  ipcMain.handle('mcp:start', async () => {
    try { await startMcp(); return ok(mcpInfo()); } catch (err) { return fail(err); }
  });

  ipcMain.handle('mcp:stop', async () => {
    try { await stopMcp(); return ok(mcpInfo()); } catch (err) { return fail(err); }
  });

  ipcMain.handle('mcp:patch', (e, patch) => {
    try {
      const p = patch || {};
      if (p.readonly !== undefined) store.setSetting('mcpReadonly', !!p.readonly);
      if (p.port !== undefined) {
        const port = Number(p.port);
        if (!(port >= 1024 && port <= 65535)) throw new Error('端口需在 1024 - 65535 之间');
        store.setSetting('mcpPort', port);
      }
      send('mcp:state', mcpInfo());
      return ok(mcpInfo());
    } catch (err) { return fail(err); }
  });

  ipcMain.handle('mcp:restart', async () => {
    try { await startMcp(); return ok(mcpInfo()); } catch (err) { return fail(err); }
  });

  ipcMain.handle('mcp:rotate', () => {
    try {
      store.setSetting('mcpToken', crypto.randomBytes(24).toString('hex'));
      send('mcp:state', mcpInfo());
      return ok(mcpInfo());
    } catch (err) { return fail(err); }
  });
}
