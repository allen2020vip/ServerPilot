/* ============================================================
   ServerPilot — renderer
   ============================================================ */
(function () {
'use strict';

const api = window.api;

/* ---------------- 小工具 ---------------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const ic = (n) => `<svg class="ic"><use href="#i-${n}"/></svg>`;
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function req(promise) {
  const r = await promise;
  if (!r || r.ok !== true) throw new Error((r && r.error) || '操作失败');
  return r.data;
}

function fmtBytes(n) {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  let v = n;
  do { v /= 1024; i++; } while (v >= 1024 && i < u.length - 1);
  return `${v.toFixed(v < 10 ? 1 : 0)} ${u[i]}`;
}

function fmtTime(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function toast(msg, type = 'info', ms = 3200) {
  const box = $('#toasts');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  const icon = type === 'ok' ? 'check' : type === 'err' ? 'alert' : type === 'warn' ? 'alert' : 'pulse';
  el.innerHTML = `${ic(icon)}<span>${esc(msg)}</span>`;
  box.appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 220);
  }, ms);
}

/* ---------------- 状态 ---------------- */
const state = {
  hosts: [],
  hostId: null,
  host: null,
  connected: false,
  cwd: null,
  selected: new Set(),
  tmpls: [],
  activeTpl: null,
  tab: 'overview',
  editor: null,
  editorFile: null,
  editorDirty: false,
  rebooting: false,
  sysTimer: null,
  entries: [],
  favorites: [],
  connBusyId: null,
  sort: { key: 'name', dir: 1 }
};

/* 记住上次的排序方式 */
try {
  const saved = JSON.parse(localStorage.getItem('sp.sort') || 'null');
  if (saved && ['name', 'size', 'mode', 'time'].includes(saved.key) && (saved.dir === 1 || saved.dir === -1)) {
    state.sort = saved;
  }
} catch (_) {}

/* ============================================================
   窗口控制
   ============================================================ */
$('#winMin').onclick = () => api.window.minimize();
$('#winMax').onclick = () => api.window.maximize();
$('#winClose').onclick = () => api.window.close();
api.window.onState(({ maximized }) => {
  const el = $('#winMax');
  el.innerHTML = maximized
    ? '<svg viewBox="0 0 10 10"><rect x="1.5" y="3" width="5.5" height="5.5" rx="1"/><path d="M3.5 3V1.8A0.8 0.8 0 013.9 1h4.3a0.8 0.8 0 01.8.8v4.3a0.8 0.8 0 01-.8.9H7"/></svg>'
    : '<svg viewBox="0 0 10 10"><rect x="1.5" y="1.5" width="7" height="7" rx="1"/></svg>';
});

/* ============================================================
   主机列表
   ============================================================ */
async function loadHosts() {
  try {
    state.hosts = await req(api.hosts.list());
  } catch (e) {
    state.hosts = [];
    toast(`读取主机列表失败：${e.message}`, 'err');
  }
  renderHosts();
}

function renderHosts() {
  const q = $('#hostSearch').value.trim().toLowerCase();
  const list = state.hosts.filter((h) =>
    !q || [h.name, h.host, h.username, h.group, h.note].some((v) => (v || '').toLowerCase().includes(q))
  );

  $('#hostCount').textContent = state.hosts.length;
  const box = $('#hostList');

  if (!list.length) {
    box.innerHTML = `<div class="dim-text" style="padding:16px 8px;text-align:center">${state.hosts.length ? '没有匹配的服务器' : '还没有服务器'}</div>`;
    return;
  }

  box.innerHTML = list
    .map((h) => {
      const active = h.id === state.hostId;
      const conn = state.activeConns && state.activeConns.has(h.id);
      const busy = state.connBusyId === h.id;
      const initial = (h.name || h.host || 'S').slice(0, 1).toUpperCase();
      return `<div class="host-item ${active ? 'active' : ''}" data-id="${h.id}">
        <div class="host-ico">${esc(initial)}</div>
        <div class="host-txt">
          <div class="host-name">${esc(h.name)}</div>
          <div class="host-addr">${esc(h.username)}@${esc(h.host)}:${esc(h.port)}</div>
        </div>
        <button class="host-conn ${conn ? 'on' : ''}" data-conn="${h.id}" ${busy ? 'disabled' : ''} title="${conn ? '断开连接' : '连接服务器'}">${busy ? '连接中' : conn ? '断开' : '连接'}</button>
      </div>`;
    })
    .join('');

  $$('.host-conn', box).forEach((btn) => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      const id = btn.dataset.conn;
      const connected = state.activeConns && state.activeConns.has(id);
      if (connected) await disconnectHost(id);
      else await selectHost(id);
    };
  });

  $$('.host-item', box).forEach((el) => {
    el.onclick = () => selectHost(el.dataset.id);
    el.oncontextmenu = (e) => {
      e.preventDefault();
      const id = el.dataset.id;
      const h = state.hosts.find((x) => x.id === id);
      showCtx(e.clientX, e.clientY, [
        { label: '连接', icon: 'power', act: () => selectHost(id) },
        { label: '编辑连接', icon: 'edit', act: () => openHostModal(h) },
        { sep: true },
        { label: '删除连接', icon: 'trash', danger: true, act: () => removeHost(h) }
      ]);
    };
  });
}

$('#hostSearch').oninput = renderHosts;

/* ============================================================
   选择 / 连接主机
   ============================================================ */
async function selectHost(id) {
  const host = state.hosts.find((h) => h.id === id);
  if (!host) return;
  const reconnect = state.hostId === id;

  state.hostId = id;
  state.host = host;
  state.connected = false;
  state.rebooting = false;
  if (!reconnect) state.cwd = null;
  state.selected.clear();
  state.connBusyId = id;

  $('#emptyState').hidden = true;
  $('#workspace').hidden = false;

  $('#wsName').textContent = host.name;
  $('#wsMeta').textContent = `${host.username}@${host.host}:${host.port}${host.group ? ' · ' + host.group : ''}`;
  $('#wsAvatar').textContent = (host.name || 'S').slice(0, 1).toUpperCase();
  setStatus('busy', '连接中');

  renderHosts();
  if (!reconnect) switchTab('overview');

  try {
    await req(api.conn.open(id));
    state.connected = true;
    state.activeConns = state.activeConns || new Set();
    state.activeConns.add(id);
    state.connBusyId = null;
    setStatus('on', '已连接');
    renderHosts();
    toast(`已连接 ${host.name}`, 'ok');
    loadOverview();
    if (state.tab === 'files') loadFiles(state.cwd || '.');
  } catch (err) {
    state.connected = false;
    state.connBusyId = null;
    setStatus('off', '连接失败');
    renderHosts();
    toast(`连接失败：${err.message}`, 'err', 6000);
  }
}

function setStatus(kind, text) {
  const el = $('#wsStatus');
  el.className = 'ws-status' + (kind === 'on' ? ' on' : kind === 'busy' ? ' busy' : '');
  el.innerHTML = `<i></i><span>${esc(text)}</span>`;
}

$('#btnReconnect').onclick = async () => {
  if (!state.host) return;
  try {
    await req(api.conn.close(state.hostId));
  } catch (_) {}
  state.connected = false;
  state.activeConns && state.activeConns.delete(state.hostId);
  await selectHost(state.hostId);
};

$('#btnDisconnect').onclick = () => disconnectHost(state.hostId);

/* 断开连接：清理运行态与概览数据 */
async function disconnectHost(id) {
  const hostId = id || state.hostId;
  if (!hostId) return;
  try { await req(api.conn.close(hostId)); } catch (_) {}
  if (state.activeConns) state.activeConns.delete(hostId);

  if (hostId === state.hostId) {
    state.connected = false;
    state.rebooting = false;
    state.selected.clear();
    setStatus('off', '已断开');
    resetOverview();
    if (state.tab === 'files') loadFiles(state.cwd || '.');
  }
  renderHosts();
  toast('已断开连接', 'info');
}

/* 概览清零：指标归位、系统信息与状态列表回到占位 */
function resetOverview() {
  ['#mCpu', '#mMem', '#mDisk'].forEach((sel) => { $(sel).textContent = '—'; });
  ['#mCpuBar', '#mMemBar', '#mDiskBar'].forEach((sel) => {
    $(sel).style.width = '0%';
    $(sel).className = '';
  });
  $('#mCpuSub').textContent = '等待采集';
  $('#mMemSub').textContent = '等待采集';
  $('#mDiskSub').textContent = '等待采集';
  $('#mUptime').textContent = '—';
  $('#mLoadSub').textContent = '—';
  $('#sysInfo').innerHTML = '<div class="dim-text" style="padding:6px 0">连接服务器后读取系统信息</div>';
  $('#svcList').innerHTML = '<div class="dim-text">点击下方按钮采集</div>';
}

$('#btnEditHost').onclick = () => state.host && openHostModal(state.host);

/* ============================================================
   Tabs
   ============================================================ */
function switchTab(name) {
  state.tab = name;
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $$('.view').forEach((v) => v.classList.toggle('active', v.dataset.view === name));

  if (name === 'overview') loadOverview();
  if (name === 'files') {
    if (!state.cwd) loadFiles('.');
    else loadFiles(state.cwd);
  }
  if (name === 'terminal') ensureTerminal();
}

$$('.tab').forEach((t) => (t.onclick = () => switchTab(t.dataset.tab)));

/* ============================================================
   概览
   ============================================================ */
const SYS_CMD = `
echo "HOSTNAME=$(hostname 2>/dev/null)"
echo "OS=$(. /etc/os-release 2>/dev/null && echo $PRETTY_NAME)"
echo "KERNEL=$(uname -r)"
echo "ARCH=$(uname -m)"
echo "CPUCORES=$(nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo)"
echo "UPTIME=$(uptime -p 2>/dev/null | sed 's/^up //' || uptime)"
echo "LOAD=$(cut -d' ' -f1-3 /proc/loadavg)"
echo "MEMTOTAL=$(free -m | awk '/^Mem:/{print $2}')"
echo "MEMUSED=$(free -m | awk '/^Mem:/{print $3}')"
echo "DISKTOTAL=$(df -m / | awk 'NR==2{print $2}')"
echo "DISKUSED=$(df -m / | awk 'NR==2{print $3}')"
echo "DISKPCT=$(df / | awk 'NR==2{gsub("%","",$5); print $5}')"
echo "IP=$(hostname -I 2>/dev/null | awk '{print $1}')"
echo "TIME=$(date '+%Y-%m-%d %H:%M:%S')"
R1=$(awk '/^cpu /{print $2+$3+$4" "$5}' /proc/stat)
sleep 0.6
R2=$(awk '/^cpu /{print $2+$3+$4" "$5}' /proc/stat)
echo "CPUUSAGE=$(echo $R1 $R2 | awk '{busy=$3-$1; total=($3+$4)-($1+$2); if(total>0) printf "%.0f", busy*100/total; else print 0}')"
`;

function parseKV(out) {
  const map = {};
  out.split(/\r?\n/).forEach((line) => {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) map[m[1]] = m[2].trim();
  });
  return map;
}

async function loadOverview() {
  if (!state.hostId || !state.connected || state.rebooting) return;
  try {
    const res = await req(api.exec.run({ hostId: state.hostId, command: SYS_CMD }));
    const chunks = [];
    const off = api.exec.onOutput(({ rid, chunk }) => { if (rid === res.rid) chunks.push(chunk); });
    const done = await new Promise((resolve) => {
      const off2 = api.exec.onDone(({ rid, code }) => {
        if (rid === res.rid) { off2(); resolve(code); }
      });
      setTimeout(() => resolve(-1), 12000);
    });
    off();
    const kv = parseKV(chunks.join(''));
    if (!state.connected) return;
    renderOverview(kv);
  } catch (err) {
    toast(`采集系统信息失败：${err.message}`, 'err');
  }
}

function barCls(pct) {
  if (pct >= 90) return 'crit';
  if (pct >= 75) return 'high';
  return '';
}

function renderOverview(kv) {
  const cpu = Number(kv.CPUUSAGE || 0);
  const memUsed = Number(kv.MEMUSED || 0);
  const memTotal = Number(kv.MEMTOTAL || 0);
  const memPct = memTotal ? Math.round((memUsed / memTotal) * 100) : 0;
  const diskPct = Number(kv.DISKPCT || 0);

  $('#mCpu').innerHTML = `${cpu}<small>%</small>`;
  $('#mCpuBar').style.width = `${Math.min(100, cpu)}%`;
  $('#mCpuBar').className = barCls(cpu);
  $('#mCpuSub').textContent = `${kv.CPUCORES || '—'} 核心 · 负载 ${kv.LOAD || '—'}`;

  $('#mMem').innerHTML = `${memPct}<small>%</small>`;
  $('#mMemBar').style.width = `${Math.min(100, memPct)}%`;
  $('#mMemBar').className = barCls(memPct);
  $('#mMemSub').textContent = `${fmtBytes(memUsed * 1024 * 1024)} / ${fmtBytes(memTotal * 1024 * 1024)}`;

  $('#mDisk').innerHTML = `${diskPct}<small>%</small>`;
  $('#mDiskBar').style.width = `${Math.min(100, diskPct)}%`;
  $('#mDiskBar').className = barCls(diskPct);
  $('#mDiskSub').textContent = `${fmtBytes(Number(kv.DISKUSED) * 1024 * 1024)} / ${fmtBytes(Number(kv.DISKTOTAL) * 1024 * 1024)}`;

  $('#mUptime').textContent = kv.UPTIME || '—';
  $('#mLoadSub').textContent = `采集于 ${kv.TIME || '—'}`;

  const rows = [
    ['主机名', kv.HOSTNAME],
    ['操作系统', kv.OS],
    ['内核版本', kv.KERNEL],
    ['架构', kv.ARCH],
    ['内网 IP', kv.IP],
    ['CPU 核心', kv.CPUCORES],
    ['负载均值', kv.LOAD],
    ['系统时间', kv.TIME]
  ];
  $('#sysInfo').innerHTML = rows
    .map(([k, v]) => `<div class="kv-row"><div class="kv-k">${esc(k)}</div><div class="kv-v">${esc(v || '—')}</div></div>`)
    .join('');
}

$('#btnSysRefresh').onclick = loadOverview;

$$('.qa').forEach((b) => {
  b.onclick = () => {
    const act = b.dataset.act;
    if (act === 'terminal') switchTab('terminal');
    if (act === 'files') switchTab('files');
    if (act === 'favorites') openFavorites();
    if (act === 'deploy') switchTab('deploy');
    if (act === 'reboot') rebootServer();
    if (act === 'top') {
      switchTab('run');
      $('#cmdInput').value = "ps aux --sort=-%cpu | head -n 12";
      runCommand();
    }
  };
});

/* ---------------- 重启服务器 ---------------- */
const REBOOT_CHECK = 'if [ "$(id -u)" = "0" ]; then echo RB_CAN; elif sudo -n true 2>/dev/null; then echo RB_CAN; else echo RB_NOCAN; fi';
const REBOOT_CMD = `nohup sh -c 'sleep 2; (reboot || shutdown -r now || sudo -n reboot || sudo -n shutdown -r now)' >/dev/null 2>&1 & echo RB_QUEUED`;

/** 一次性收集命令输出（复用 exec 流） */
function collectExec(hostId, command, timeout = 8000) {
  return new Promise(async (resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const res = await req(api.exec.run({ hostId, command }));
      const chunks = [];
      const offOut = api.exec.onOutput(({ rid, chunk }) => { if (rid === res.rid) chunks.push(chunk); });
      const offDone = api.exec.onDone(({ rid, code }) => {
        if (rid !== res.rid) return;
        offOut(); offDone();
        finish({ code, out: chunks.join('') });
      });
      setTimeout(() => { offOut(); offDone(); finish({ code: -1, out: chunks.join('') }); }, timeout);
    } catch (err) {
      finish({ code: -1, out: '', error: err.message });
    }
  });
}

async function rebootServer() {
  if (!state.connected || !state.hostId) return toast('请先连接服务器', 'warn');
  if (state.rebooting) return toast('重启指令已下发，正在等待服务器恢复', 'warn');

  const name = (state.host && state.host.name) || '当前服务器';
  const addr = state.host ? `${state.host.username}@${state.host.host}` : '';
  const ok = await confirmDialog(
    '重启服务器',
    `即将重启 <b style="color:#EDF0F5">${esc(name)}</b>${addr ? ` <span style="font-family:var(--mono);color:#6D7481">${esc(addr)}</span>` : ''}。<br>
     <span style="display:block;margin-top:8px;color:#A2A9B7">所有 SSH 连接会立即中断，正在运行的服务短暂不可用，通常 30–90 秒后恢复。</span>`,
    '确认重启',
    true
  );
  if (!ok) return;

  // 先确认权限，避免后端静默失败
  const pre = await collectExec(state.hostId, REBOOT_CHECK, 8000);
  const lines = (pre.out || '').split(/\r?\n/).map((l) => l.trim());
  if (!lines.includes('RB_CAN')) {
    toast('当前用户没有重启权限：需要 root，或配置了免密 sudo', 'err', 6000);
    return;
  }

  try {
    await req(api.exec.run({ hostId: state.hostId, command: REBOOT_CMD }));
  } catch (err) {
    toast(`重启指令下发失败：${err.message}`, 'err', 5000);
    return;
  }

  state.rebooting = true;
  setStatus('busy', '重启中');
  toast('重启指令已下发，等待服务器恢复…', 'warn', 4200);
  watchReboot(state.hostId, name);
}

async function watchReboot(hostId, name) {
  await new Promise((r) => setTimeout(r, 26000));
  for (let i = 0; i < 22; i++) {
    if (state.hostId !== hostId) return; // 已切换到别的服务器
    try { await req(api.conn.close(hostId)); } catch (_) {}
    try {
      await req(api.conn.open(hostId));
      state.rebooting = false;
      state.connected = true;
      setStatus('on', '已连接');
      toast(`服务器 ${name} 已恢复`, 'ok', 4200);
      renderHosts();
      if (state.tab === 'overview') loadOverview();
      return;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 6500));
  }
  if (state.hostId !== hostId) return;
  state.rebooting = false;
  state.connected = false;
  setStatus('off', '未连接');
  toast('服务器 2 分钟内没有恢复，请手动检查', 'err', 6000);
}

const SERVICES = ['nginx', 'docker', 'mysql', 'postgresql', 'redis-server', 'ssh', 'firewalld', 'ufw'];

$('#btnSvcScan').onclick = async () => {
  if (!state.connected) return toast('请先连接服务器', 'warn');
  const box = $('#svcList');
  box.innerHTML = '<div class="dim-text">扫描中…</div>';
  try {
    const cmd = SERVICES.map((s) => `printf "%s|%s\\n" ${s} "$(systemctl is-active ${s} 2>/dev/null || echo none)"`).join(';');
    const res = await req(api.exec.run({ hostId: state.hostId, command: cmd }));
    const chunks = [];
    const off = api.exec.onOutput(({ rid, chunk }) => { if (rid === res.rid) chunks.push(chunk); });
    await new Promise((resolve) => {
      const off2 = api.exec.onDone(({ rid }) => { if (rid === res.rid) { off2(); resolve(); } });
      setTimeout(resolve, 8000);
    });
    off();
    const lines = chunks.join('').split(/\r?\n/).filter((l) => l.includes('|'));
    if (!lines.length) {
      box.innerHTML = '<div class="dim-text">未检测到 systemd 服务</div>';
      return;
    }
    box.innerHTML = lines
      .map((l) => {
        const [name, st] = l.split('|');
        const run = st === 'active';
        return `<div class="svc-row"><span class="svc-name">${esc(name)}</span><span class="svc-tag ${run ? 'run' : 'stop'}">${run ? 'running' : esc(st)}</span></div>`;
      })
      .join('');
  } catch (err) {
    box.innerHTML = `<div class="dim-text">扫描失败：${esc(err.message)}</div>`;
  }
};

/* ============================================================
   终端
   ============================================================ */
const termMap = new Map(); // sid -> { term, fit, el }
let termSeq = 0;

function termTheme() {
  const light = document.documentElement.getAttribute('data-theme') === 'light';
  if (light) {
    return {
      background: '#FFFFFF',
      foreground: '#24292F',
      cursor: '#3363D8',
      cursorAccent: '#FFFFFF',
      selectionBackground: 'rgba(51,99,216,0.22)',
      black: '#24292F', red: '#CF222E', green: '#116329', yellow: '#953800',
      blue: '#0969DA', magenta: '#8250DF', cyan: '#1B7C83', white: '#6E7781',
      brightBlack: '#57606A', brightRed: '#A40E26', brightGreen: '#1A7F37', brightYellow: '#7D4E00',
      brightBlue: '#0550AE', brightMagenta: '#6639BA', brightCyan: '#0F6E75', brightWhite: '#24292F'
    };
  }
  return {
    background: '#08090B',
    foreground: '#C9D1E0',
    cursor: '#7FA4FF',
    cursorAccent: '#08090B',
    selectionBackground: 'rgba(91,139,255,0.28)',
    black: '#3B4048', red: '#F07178', green: '#7FD88F', yellow: '#F5C06B',
    blue: '#7FA4FF', magenta: '#C792EA', cyan: '#89DDFF', white: '#C9D1E0',
    brightBlack: '#5A6475', brightRed: '#FF8C93', brightGreen: '#9BE8A9', brightYellow: '#FFD79A',
    brightBlue: '#A5C0FF', brightMagenta: '#DFB4F5', brightCyan: '#A6E9FF', brightWhite: '#F2F5FA'
  };
}

async function ensureTerminal() {
  if (!$('#term').childElementCount) {
    await newTerminal();
  } else {
    setTimeout(() => fitActiveTerm(), 40);
  }
}

async function newTerminal() {
  if (!state.hostId) return;
  if (!state.connected) {
    toast('请先连接服务器', 'warn');
    return;
  }

  const hostEl = $('#term');
  const wrap = document.createElement('div');
  wrap.className = 'term-instance';
  wrap.style.cssText = 'position:absolute;inset:0;padding:0 0 0 6px;';
  hostEl.appendChild(wrap);

  const term = new window.Terminal({
    fontFamily: '"JetBrains Mono", "Cascadia Mono", Consolas, monospace',
    fontSize: 12.5,
    lineHeight: 1.35,
    cursorBlink: true,
    cursorStyle: 'bar',
    scrollback: 8000,
    allowTransparency: true,
    theme: termTheme()
  });
  const fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(wrap);
  try { fit.fit(); } catch (_) {}

  let sid = null;
  try {
    const r = await req(api.shell.open({ hostId: state.hostId, cols: term.cols, rows: term.rows }));
    sid = r.sid;
  } catch (err) {
    toast(`终端打开失败：${err.message}`, 'err');
    wrap.remove();
    return;
  }

  const id = ++termSeq;
  const rec = { id, sid, term, fit, el: wrap, title: `Shell ${id}` };
  termMap.set(id, rec);

  term.onData((d) => api.shell.write({ sid, data: d }));
  term.onResize(({ cols, rows }) => api.shell.resize({ sid, cols, rows }));

  renderTermTabs(id);
  activateTerm(id);
  term.focus();
}

function renderTermTabs(activeId) {
  const box = $('#termTabs');
  box.innerHTML = Array.from(termMap.values())
    .map(
      (r) => `<button class="term-chip ${r.id === activeId ? 'active' : ''}" data-tid="${r.id}"><i></i>${esc(r.title)}</button>`
    )
    .join('');
  $$('.term-chip', box).forEach((el) => {
    el.onclick = () => activateTerm(Number(el.dataset.tid));
    el.oncontextmenu = (e) => {
      e.preventDefault();
      const tid = Number(el.dataset.tid);
      showCtx(e.clientX, e.clientY, [{ label: '关闭终端', icon: 'close', danger: true, act: () => closeTerm(tid) }]);
    };
  });
}

function activateTerm(id) {
  const rec = termMap.get(id);
  if (!rec) return;
  termMap.forEach((r) => { r.el.style.display = r.id === id ? 'block' : 'none'; });
  renderTermTabs(id);
  setTimeout(() => { try { rec.fit.fit(); rec.term.focus(); } catch (_) {} }, 30);
}

function fitActiveTerm() {
  const active = Array.from(termMap.values()).find((r) => r.el.style.display !== 'none');
  if (active) { try { active.fit.fit(); } catch (_) {} }
}

function closeTerm(id) {
  const rec = termMap.get(id);
  if (!rec) return;
  try { api.shell.close({ sid: rec.sid }); } catch (_) {}
  try { rec.term.dispose(); } catch (_) {}
  rec.el.remove();
  termMap.delete(id);
  const next = termMap.values().next().value;
  if (next) activateTerm(next.id);
  else renderTermTabs(-1);
}

api.shell.onData(({ sid, data }) => {
  for (const r of termMap.values()) {
    if (r.sid === sid) { r.term.write(data); break; }
  }
});

api.shell.onExit(({ sid }) => {
  for (const r of termMap.values()) {
    if (r.sid === sid) { r.term.write('\r\n\x1b[38;5;244m[连接已关闭]\x1b[0m\r\n'); break; }
  }
});

$('#termNew').onclick = () => newTerminal();
$('#termClear').onclick = () => {
  const active = Array.from(termMap.values()).find((r) => r.el.style.display !== 'none');
  if (active) active.term.clear();
};

/* ============================================================
   文件管理
   ============================================================ */
async function loadFiles(dir) {
  if (!state.hostId) return;
  if (!state.connected) {
    $('#crumbs').innerHTML = '<span class="crumb last">未连接</span>';
    $('#fileList').innerHTML = '<div class="dim-text" style="padding:24px">连接服务器后即可浏览和管理远程文件</div>';
    $('#fileEmpty').hidden = true;
    return;
  }
  const box = $('#fileList');
  box.innerHTML = '<div class="dim-text" style="padding:20px">加载中…</div>';
  try {
    const data = await req(api.files.list({ hostId: state.hostId, dir: dir || '.' }));
    state.cwd = data.path;
    renderCrumbs(data.path);
    renderFileRows(data.entries);
  } catch (err) {
    box.innerHTML = `<div class="dim-text" style="padding:20px;color:var(--danger)">${esc(err.message)}</div>`;
  }
}

function renderCrumbs(path) {
  const parts = path.split('/').filter(Boolean);
  const box = $('#crumbs');
  let acc = '';
  let html = `<button class="crumb" data-path="/"><b style="font-weight:600">/</b></button>`;
  parts.forEach((p, i) => {
    acc += '/' + p;
    html += `<span class="crumb-sep">${i === 0 ? '' : '/'}</span><button class="crumb ${i === parts.length - 1 ? 'last' : ''}" data-path="${esc(acc)}">${esc(p)}</button>`;
  });
  box.innerHTML = html;
  $$('.crumb', box).forEach((el) => (el.onclick = () => loadFiles(el.dataset.path)));
}

/* 排序：目录恒在前，组内按所选列 */
const nameCollator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });

function sortEntries(entries) {
  const { key, dir } = state.sort;
  const sign = dir === -1 ? -1 : 1;
  return entries.slice().sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    let r = 0;
    if (key === 'name') r = nameCollator.compare(a.name, b.name);
    else if (key === 'size') r = (a.size || 0) - (b.size || 0);
    else if (key === 'mode') r = String(a.modeText || '').localeCompare(String(b.modeText || ''));
    else if (key === 'time') r = (a.mtime || 0) - (b.mtime || 0);
    if (r === 0) return nameCollator.compare(a.name, b.name);
    return r * sign;
  });
}

function updateSortHead() {
  $$('.file-list-head .sort').forEach((b) => {
    const on = b.dataset.sort === state.sort.key;
    b.classList.toggle('active', on);
    b.classList.toggle('asc', on && state.sort.dir === 1);
    b.classList.toggle('desc', on && state.sort.dir === -1);
    const label = b.textContent;
    b.title = on
      ? `按${label}${state.sort.dir === 1 ? '升序' : '降序'}排列，点击反向`
      : `按${label}排序`;
    b.setAttribute('aria-sort', on ? (state.sort.dir === 1 ? 'ascending' : 'descending') : 'none');
  });
}

function bindSortHead() {
  $$('.file-list-head .sort').forEach((b) => {
    b.onclick = () => {
      const key = b.dataset.sort;
      if (state.sort.key === key) {
        state.sort.dir = state.sort.dir === 1 ? -1 : 1;
      } else {
        /* 大小、时间默认降序，名称、权限默认升序 */
        state.sort = { key, dir: key === 'size' || key === 'time' ? -1 : 1 };
      }
      try { localStorage.setItem('sp.sort', JSON.stringify(state.sort)); } catch (_) {}
      updateSortHead();
      if (state.entries && state.entries.length) renderFileRows(state.entries);
    };
  });
}

function renderFileRows(entries) {
  const box = $('#fileList');
  const keep = new Set(state.selected);
  const keepIsDir = state.selectedIsDir;

  $('#fileEmpty').hidden = entries.length > 0;
  state.entries = entries;
  state.selected = new Set();
  updateSortHead();

  box.innerHTML = sortEntries(entries)
    .map((e) => {
      const icon = e.isDir ? 'folder' : 'file';
      const fav = isFavorited(e.path) ? '<svg class="ic fav-mark"><use href="#i-star"/></svg>' : '';
      return `<div class="file-row ${e.isDir ? 'dir' : ''}" data-path="${esc(e.path)}" data-dir="${e.isDir}" data-name="${esc(e.name)}">
        <div class="f-ico">${ic(icon)}</div>
        <div class="f-name"><span class="f-name-txt">${esc(e.name)}</span>${fav}</div>
        <div class="f-size">${e.isDir ? '—' : fmtBytes(e.size)}</div>
        <div class="f-mode">${esc(e.modeText || '')}</div>
        <div class="f-time">${fmtTime(e.mtime)}</div>
      </div>`;
    })
    .join('');

  $$('.file-row', box).forEach((row) => {
    if (keep.has(row.dataset.path)) {
      row.classList.add('sel');
      state.selected.add(row.dataset.path);
      state.selectedIsDir = keepIsDir;
    }
    row.onclick = (e) => {
      $$('.file-row', box).forEach((r) => r.classList.remove('sel'));
      row.classList.add('sel');
      state.selected = new Set([row.dataset.path]);
      state.selectedIsDir = row.dataset.dir === 'true';
    };
    row.ondblclick = () => {
      if (row.dataset.dir === 'true') loadFiles(row.dataset.path);
      else openEditor(row.dataset.path);
    };
    row.oncontextmenu = (e) => {
      e.preventDefault();
      const isDir = row.dataset.dir === 'true';
      const path = row.dataset.path;
      $$('.file-row', box).forEach((r) => r.classList.remove('sel'));
      row.classList.add('sel');
      state.selected = new Set([path]);
      state.selectedIsDir = isDir;

      const items = [];
      if (!isDir) items.push({ label: '在线编辑', icon: 'edit', act: () => openEditor(path) });
      items.push({ label: '下载', icon: 'download', act: () => downloadPaths([path]) });
      items.push({ sep: true });
      items.push({
        label: isFavorited(path) ? '取消收藏' : '收藏',
        icon: 'star',
        act: () => toggleFavorite({ path, name: row.dataset.name, isDir })
      });
      items.push({ label: '重命名', icon: 'code', act: () => renamePath(path, row.dataset.name) });
      if (!isDir) items.push({ label: '修改权限', icon: 'shield', act: () => changeMode(path) });
      items.push({ label: '复制路径', icon: 'copy', act: () => copyText(path) });
      items.push({ sep: true });
      items.push({ label: '删除', icon: 'trash', danger: true, act: () => deletePaths([path], isDir) });
      showCtx(e.clientX, e.clientY, items);
    };
  });
}

$('#fileRefresh').onclick = () => loadFiles(state.cwd || '.');

/* ---------------- 收藏夹 ---------------- */
async function loadFavorites() {
  try { state.favorites = await req(api.favorites.list()); } catch (_) { state.favorites = []; }
  if (!$('#favOverlay').hidden) renderFavorites();
  if (state.entries && state.entries.length) renderFileRows(state.entries);
}

function isFavorited(p) {
  if (!state.hostId) return false;
  return state.favorites.some((f) => f.hostId === state.hostId && f.path === p);
}

async function toggleFavorite({ path, name, isDir }) {
  if (!state.hostId) return toast('请先连接服务器', 'warn');
  const existing = state.favorites.find((f) => f.hostId === state.hostId && f.path === path);
  try {
    if (existing) {
      await req(api.favorites.remove(existing.id));
      toast('已取消收藏', 'info');
    } else {
      await req(api.favorites.add({ hostId: state.hostId, path, name, isDir }));
      toast(isDir ? '文件夹已加入收藏' : '文件已加入收藏', 'ok');
    }
    await loadFavorites();
  } catch (err) { toast(err.message, 'err'); }
}

function favHostLabel(hostId) {
  const h = state.hosts.find((x) => x.id === hostId);
  return h ? h.name : '已删除的服务器';
}

function renderFavorites() {
  const box = $('#favList');
  const list = state.favorites.slice().sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));

  if (!list.length) {
    box.innerHTML = `<div class="fav-empty"><svg class="ic"><use href="#i-star"/></svg><b>还没有收藏</b><small>在文件列表里右键文件或文件夹 → 收藏</small></div>`;
    return;
  }

  box.innerHTML = list
    .map((f) => `<div class="fav-row" data-id="${esc(f.id)}">
      <div class="f-ico ${f.isDir ? '' : 'is-file'}">${ic(f.isDir ? 'folder' : 'file')}</div>
      <div class="fav-main">
        <div class="fav-name">${esc(f.name)}</div>
        <div class="fav-path">${esc(f.path)}</div>
      </div>
      <div class="fav-host" title="${esc(favHostLabel(f.hostId))}">${esc(favHostLabel(f.hostId))}</div>
      <button class="btn btn-icon sm fav-del" data-del="${esc(f.id)}" title="取消收藏"><svg class="ic"><use href="#i-close"/></svg></button>
    </div>`)
    .join('');

  $$('.fav-row', box).forEach((row) => {
    row.onclick = (e) => {
      if (e.target.closest('.fav-del')) return;
      const f = state.favorites.find((x) => x.id === row.dataset.id);
      if (f) openFavorite(f);
    };
  });

  $$('.fav-del', box).forEach((btn) => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      try {
        await req(api.favorites.remove(btn.dataset.del));
        toast('已取消收藏', 'info');
        await loadFavorites();
      } catch (err) { toast(err.message, 'err'); }
    };
  });
}

function openFavorites() {
  $('#favOverlay').hidden = false;
  renderFavorites();
}

function closeFavorites() {
  $('#favOverlay').hidden = true;
}

async function openFavorite(f) {
  closeFavorites();
  const offline = f.hostId !== state.hostId || !state.connected;
  if (offline) {
    const host = state.hosts.find((h) => h.id === f.hostId);
    if (!host) return toast('该收藏所属的服务器已被删除', 'err');
    await selectHost(f.hostId);
    if (!state.connected) return;
  }
  switchTab('files');
  if (f.isDir) {
    await loadFiles(f.path);
  } else {
    const dir = f.path.replace(/\/[^/]*$/, '') || '/';
    await loadFiles(dir);
    openEditor(f.path);
  }
}

$('#favClose').onclick = closeFavorites;
$('#favOverlay').onclick = (e) => { if (e.target.id === 'favOverlay') closeFavorites(); };
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#favOverlay').hidden) closeFavorites();
});
bindSortHead();
updateSortHead();
$('#fileUpload').onclick = async () => {
  const paths = await req(api.dialog.pickFiles());
  if (!paths || !paths.length) return;
  uploadLocal(paths);
};
$('#fileDownload').onclick = () => {
  const sel = Array.from(state.selected);
  if (!sel.length) return toast('请先选择一个文件', 'warn');
  downloadPaths(sel);
};
$('#fileMkdir').onclick = async () => {
  const name = await askText('新建文件夹', '文件夹名称', '');
  if (!name) return;
  try {
    await req(api.files.mkdir({ hostId: state.hostId, dir: state.cwd.replace(/\/+$/, '') + '/' + name }));
    toast('文件夹已创建', 'ok');
    loadFiles(state.cwd);
  } catch (err) { toast(err.message, 'err'); }
};

async function uploadLocal(paths) {
  if (!state.cwd) return toast('请先进入一个目录', 'warn');
  const panel = $('#transfers');
  const el = document.createElement('div');
  el.className = 'transfer';
  el.innerHTML = `<div class="t-top"><span class="t-name">准备上传…</span><span class="t-pct">0%</span></div><div class="t-bar"><i style="width:0%"></i></div>`;
  panel.appendChild(el);
  try {
    await req(api.files.upload({ hostId: state.hostId, localPaths: paths, remoteDir: state.cwd }));
    toast(`已上传 ${paths.length} 个项目`, 'ok');
    loadFiles(state.cwd);
  } catch (err) {
    toast(`上传失败：${err.message}`, 'err', 6000);
  } finally {
    setTimeout(() => el.remove(), 900);
  }
}

async function downloadPaths(remotePaths) {
  const localDir = await req(api.dialog.pickFolder());
  if (!localDir) return;
  const panel = $('#transfers');
  const el = document.createElement('div');
  el.className = 'transfer';
  el.innerHTML = `<div class="t-top"><span class="t-name">正在下载…</span><span class="t-pct">0%</span></div><div class="t-bar"><i style="width:0%"></i></div>`;
  panel.appendChild(el);
  try {
    const files = await req(api.files.download({ hostId: state.hostId, remotePaths, localDir }));
    toast(`已下载到 ${localDir}`, 'ok', 4000);
    api.system.openLocal({ target: null });
  } catch (err) {
    toast(`下载失败：${err.message}`, 'err', 6000);
  } finally {
    setTimeout(() => el.remove(), 900);
  }
}

api.transfer.onProgress((p) => {
  const el = $('#transfers').lastElementChild;
  if (!el) return;
  const nameEl = $('.t-name', el);
  const pctEl = $('.t-pct', el);
  const barEl = $('.t-bar i', el);
  const label = p.kind === 'upload' ? '↑ 上传' : p.kind === 'download' ? '↓ 下载' : '删除';
  nameEl.textContent = `${label} ${p.name || ''}`;
  pctEl.textContent = `${p.percent || 0}%`;
  barEl.style.width = `${p.percent || 0}%`;
});

async function renamePath(path, name) {
  const next = await askText('重命名', '新的名称', name);
  if (!next || next === name) return;
  const dir = path.slice(0, path.lastIndexOf('/'));
  try {
    await req(api.files.rename({ hostId: state.hostId, from: path, to: dir + '/' + next }));
    toast('已重命名', 'ok');
    loadFiles(state.cwd);
  } catch (err) { toast(err.message, 'err'); }
}

async function changeMode(path) {
  const mode = await askText('修改权限', '八进制权限，例如 644 / 755', '644');
  if (!mode) return;
  try {
    await req(api.files.chmod({ hostId: state.hostId, file: path, mode: parseInt(mode, 8) }));
    toast('权限已更新', 'ok');
    loadFiles(state.cwd);
  } catch (err) { toast(err.message, 'err'); }
}

async function deletePaths(paths, isDir) {
  const okc = await confirmDialog('删除确认', `确定删除 <b>${esc(paths.join('、'))}</b> 吗？该操作不可撤销。`, '删除');
  if (!okc) return;
  try {
    await req(api.files.remove({ hostId: state.hostId, targets: paths.map((p) => ({ path: p, isDir: !!isDir })) }));
    toast('已删除', 'ok');
    loadFiles(state.cwd);
  } catch (err) { toast(err.message, 'err'); }
}

/* 拖拽上传 */
const fileDropEl = $('#fileDrop');
let dragDepth = 0;
fileDropEl.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  fileDropEl.classList.add('dragging');
});
fileDropEl.addEventListener('dragover', (e) => e.preventDefault());
fileDropEl.addEventListener('dragleave', (e) => {
  e.preventDefault();
  dragDepth--;
  if (dragDepth <= 0) { dragDepth = 0; fileDropEl.classList.remove('dragging'); }
});
fileDropEl.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  fileDropEl.classList.remove('dragging');
});

if (api.onFileDrop) {
  api.onFileDrop((paths) => {
    if (state.tab === 'files' && paths.length) uploadLocal(paths);
  });
}

/* ============================================================
   部署
   ============================================================ */
async function loadTemplates() {
  try {
    state.tmpls = await req(api.deploy.templates());
    renderTemplates();
    if (state.tmpls.length) selectTemplate(state.tmpls[0].id);
  } catch (err) {
    toast(`读取模板失败：${err.message}`, 'err');
  }
}

function renderTemplates() {
  const box = $('#tplList');
  box.innerHTML = state.tmpls
    .map(
      (t) => `<button class="tpl-card ${state.activeTpl === t.id ? 'active' : ''}" data-id="${t.id}">
        <div class="tpl-ico" style="background:linear-gradient(150deg, ${esc(t.accent)}e6, ${esc(t.accent)}99)">${esc(t.badge || t.category.slice(0, 1))}</div>
        <div>
          <div class="t-name">${esc(t.name)}</div>
          <div class="t-sub">${esc(t.subtitle)}</div>
        </div>
      </button>`
    )
    .join('');
  $$('.tpl-card', box).forEach((el) => (el.onclick = () => selectTemplate(el.dataset.id)));
}

function selectTemplate(id) {
  const tpl = state.tmpls.find((t) => t.id === id);
  if (!tpl) return;
  state.activeTpl = id;
  renderTemplates();
  $('#tplName').textContent = tpl.name;
  $('#tplSub').textContent = tpl.subtitle;
  $('#btnDeployRun').disabled = false;

  const form = $('#cfgForm');
  form.innerHTML = tpl.fields
    .map((f) => {
      const full = f.type === 'textarea' ? ' field-full' : '';
      if (f.type === 'bool') {
        return `<div class="field${full}"><span>${esc(f.label)}</span>
          <label class="switch" style="height:34px"><input type="checkbox" data-key="${f.key}" ${f.default ? 'checked' : ''}/><span class="track"></span><em>启用</em></label>
        </div>`;
      }
      if (f.type === 'folder' || f.type === 'file') {
        return `<label class="field${full}"><span>${esc(f.label)}</span>
          <div class="row"><input data-key="${f.key}" data-type="${f.type}" value="${esc(f.default || '')}" placeholder="选择本地${f.type === 'folder' ? '目录' : '文件'}…" readonly />
          <button type="button" class="btn btn-ghost" data-pick="${f.key}" data-ptype="${f.type}">${ic('folder')}<span>浏览</span></button></div>
        </label>`;
      }
      if (f.type === 'textarea') {
        return `<label class="field${full}"><span>${esc(f.label)}</span><textarea data-key="${f.key}" rows="7">${esc(f.default || '')}</textarea></label>`;
      }
      return `<label class="field${full}"><span>${esc(f.label)}</span><input data-key="${f.key}" value="${esc(f.default || '')}" placeholder="${esc(f.placeholder || '')}" /></label>`;
    })
    .join('');

  $$('[data-pick]', form).forEach((b) => {
    b.onclick = async () => {
      const type = b.dataset.ptype;
      const val = type === 'folder' ? await req(api.dialog.pickFolder()) : (await req(api.dialog.pickFiles()))[0];
      if (val) $(`[data-key="${b.dataset.pick}"]`, form).value = val;
    };
  });
}

function collectValues() {
  const values = {};
  $$('[data-key]', $('#cfgForm')).forEach((el) => {
    values[el.dataset.key] = el.type === 'checkbox' ? el.checked : el.value;
  });
  return values;
}

$('#btnDeployRun').onclick = async () => {
  if (!state.activeTpl) return;
  if (!state.connected) return toast('请先连接服务器', 'warn');
  const values = collectValues();
  const log = $('#deployLog');
  log.innerHTML = '';
  appendLog({ level: 'section', text: '正在初始化部署流程…' });
  $('#btnDeployRun').disabled = true;

  const offLog = api.deploy.onLog(({ level, text }) => appendLog({ level, text }));
  const offProg = api.deploy.onProgress(({ done, total }) => {
    if (total) $('#tplSub').textContent = `执行中 ${done}/${total}`;
  });

  try {
    await req(api.deploy.run({
      hostId: state.hostId,
      planId: state.activeTpl,
      values,
      privileged: $('#sudoMode').checked
    }));
    toast('部署流程执行完毕', 'ok', 4000);
  } catch (err) {
    appendLog({ level: 'error', text: err.message });
    toast(`部署失败：${err.message}`, 'err', 6000);
  } finally {
    offLog();
    offProg();
    $('#btnDeployRun').disabled = false;
    $('#tplSub').textContent = state.tmpls.find((t) => t.id === state.activeTpl)?.subtitle || '';
  }
};

function appendLog({ level, text }) {
  const log = $('#deployLog');
  const span = document.createElement('span');
  span.className = `ln ${level || 'out'}`;
  span.textContent = text;
  log.appendChild(span);
  log.scrollTop = log.scrollHeight;
}

$('#btnClearLog').onclick = () => ($('#deployLog').innerHTML = '');

/* ============================================================
   命令
   ============================================================ */
const QUICK_CMDS = [
  'df -h',
  'free -h',
  'systemctl status nginx',
  'docker ps -a',
  'ls -lah /var/log',
  'tail -n 100 /var/log/syslog',
  'ss -lntup',
  'ps aux --sort=-%mem | head'
];

function renderCmdChips() {
  $('#runSuggest').innerHTML = QUICK_CMDS.map((c) => `<button class="chip" data-cmd="${esc(c)}">${esc(c)}</button>`).join('');
  $$('.chip', $('#runSuggest')).forEach((el) => {
    el.onclick = () => { $('#cmdInput').value = el.dataset.cmd; $('#cmdInput').focus(); };
  });
}

async function runCommand(ridPrefix) {
  if (!state.connected) return toast('请先连接服务器', 'warn');
  const input = $('#cmdInput');
  const cmd = input.value.trim();
  if (!cmd) return;
  input.value = '';
  const out = $('#runOut');

  const head = document.createElement('div');
  head.style.cssText = 'color:#7FA4FF;margin-top:6px';
  head.textContent = `$ ${cmd}`;
  out.appendChild(head);

  const off = api.exec.onOutput(({ rid, stream, chunk }) => {
    if (rid !== state.lastRid) return;
    const span = document.createElement('span');
    span.style.color = stream === 'stderr' ? '#F58A8E' : '#A2A9B7';
    span.textContent = chunk;
    out.appendChild(span);
    out.scrollTop = out.scrollHeight;
  });

  try {
    const r = await req(api.exec.run({ hostId: state.hostId, command: cmd }));
    state.lastRid = r.rid;
  } catch (err) {
    const span = document.createElement('div');
    span.style.color = '#F2555A';
    span.textContent = err.message;
    out.appendChild(span);
  } finally {
    setTimeout(() => off(), 60000);
  }
}

$('#btnRunCmd').onclick = () => runCommand();
$('#cmdInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); runCommand(); }
});
$('#btnClearRun').onclick = () => ($('#runOut').innerHTML = '');

/* ============================================================
   编辑器
   ============================================================ */
function modeOf(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  const map = {
    sh: 'shell', bash: 'shell', zsh: 'shell', env: 'shell', service: 'shell', conf: 'nginx', nginx: 'nginx',
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'javascript', json: 'javascript',
    html: 'htmlmixed', htm: 'htmlmixed', css: 'css', scss: 'css', less: 'css',
    xml: 'xml', svg: 'xml', yml: 'yaml', yaml: 'yaml', py: 'python', md: 'shell'
  };
  const m = map[ext] || 'shell';
  if (ext === 'json') return { name: 'javascript', json: true };
  return m;
}

async function openEditor(file) {
  try {
    const data = await req(api.files.read({ hostId: state.hostId, file }));
    if (data.binary) {
      toast('二进制文件不支持在线编辑，请下载后处理', 'warn');
      return;
    }
    state.editorFile = data;
    state.editorDirty = false;
    $('#edName').textContent = data.name;
    $('#edMeta').textContent = `${file} · ${fmtBytes(data.size)}`;
    $('#edState').textContent = '已同步';
    $('#edState').classList.remove('dirty');
    $('#editorOverlay').hidden = false;

    if (state.editor) { try { state.editor.toTextArea(); } catch (_) {} state.editor = null; }

    state.editor = CodeMirror.fromTextArea($('#edArea'), {
      mode: modeOf(data.name),
      lineNumbers: true,
      indentUnit: 4,
      tabSize: 4,
      lineWrapping: false,
      styleActiveLine: true,
      viewportMargin: Infinity,
      extraKeys: {
        'Ctrl-S': () => saveEditor(),
        'Cmd-S': () => saveEditor()
      }
    });
    state.editor.setValue(data.content);
    state.editor.on('change', () => {
      if (!state.editorDirty) {
        state.editorDirty = true;
        $('#edState').textContent = '未保存的修改';
        $('#edState').classList.add('dirty');
      }
    });
    state.editor.on('cursorActivity', () => {
      const c = state.editor.getCursor();
      $('#edPos').textContent = `行 ${c.line + 1}, 列 ${c.ch + 1}`;
    });
    $('#edLang').textContent = data.name.split('.').pop() || 'text';
    setTimeout(() => { state.editor.refresh(); state.editor.focus(); }, 40);
  } catch (err) {
    toast(`打开失败：${err.message}`, 'err');
  }
}

async function saveEditor() {
  if (!state.editorFile || !state.editor) return;
  const content = state.editor.getValue();
  $('#edState').textContent = '保存中…';
  $('#edState').classList.remove('dirty');
  try {
    await req(api.files.save({
      hostId: state.hostId,
      file: state.editorFile.path,
      content,
      encoding: 'utf8'
    }));
    state.editorDirty = false;
    const t = new Date();
    $('#edState').textContent = `已保存 ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
    toast('文件已保存', 'ok');
  } catch (err) {
    $('#edState').textContent = '保存失败';
    $('#edState').classList.add('dirty');
    toast(`保存失败：${err.message}`, 'err');
  }
}

function closeEditor(force) {
  if (!force && state.editorDirty) {
    confirmDialog('放弃修改？', '当前文件有未保存的修改，关闭后将丢失。', '放弃修改').then((ok) => {
      if (ok) closeEditor(true);
    });
    return;
  }
  $('#editorOverlay').hidden = true;
  if (state.editor) { try { state.editor.toTextArea(); } catch (_) {} state.editor = null; }
  state.editorFile = null;
  state.editorDirty = false;
}

$('#edSave').onclick = saveEditor;
$('#edClose').onclick = () => closeEditor(false);

/* ============================================================
   对话框
   ============================================================ */
let confirmResolver = null;
function confirmDialog(title, body, okText = '确认', danger = true) {
  $('#cfTitle').textContent = title;
  $('#cfBody').innerHTML = body;
  $('#cfOk').textContent = okText;
  $('#cfOk').className = danger ? 'btn btn-danger' : 'btn btn-primary';
  $('#confirmModal').hidden = false;
  return new Promise((resolve) => { confirmResolver = resolve; });
}
function resolveConfirm(v) {
  $('#confirmModal').hidden = true;
  if (confirmResolver) { confirmResolver(v); confirmResolver = null; }
}
$('#cfOk').onclick = () => resolveConfirm(true);
$('#cfCancel').onclick = () => resolveConfirm(false);

let promptResolver = null;
function askText(title, label, def = '') {
  $('#pmTitle').textContent = title;
  $('#pmLabel').textContent = label;
  $('#pmInput').value = def;
  $('#promptModal').hidden = false;
  setTimeout(() => { $('#pmInput').focus(); $('#pmInput').select(); }, 50);
  return new Promise((resolve) => { promptResolver = resolve; });
}
function resolvePrompt(v) {
  $('#promptModal').hidden = true;
  if (promptResolver) { promptResolver(v); promptResolver = null; }
}
$('#pmOk').onclick = () => resolvePrompt($('#pmInput').value.trim() || null);
$('#pmCancel').onclick = () => resolvePrompt(null);
$('#pmInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); resolvePrompt($('#pmInput').value.trim() || null); }
});

/* ============================================================
   右键菜单
   ============================================================ */
function showCtx(x, y, items) {
  const el = $('#ctxMenu');
  el.hidden = false;
  el.innerHTML = items
    .map((it) =>
      it.sep
        ? '<div class="ctx-sep"></div>'
        : `<button class="ctx-item ${it.danger ? 'danger' : ''}">${ic(it.icon || 'chevron')}<span>${esc(it.label)}</span></button>`
    )
    .join('');

  let idx = 0;
  const acts = [];
  $$('.ctx-item', el).forEach((b, i) => {
    const item = items.filter((x2) => !x2.sep)[i];
    acts.push(item.act);
    b.onclick = () => { hideCtx(); item.act && item.act(); };
  });

  el.style.left = '0px';
  el.style.top = '0px';
  const rect = el.getBoundingClientRect();
  el.style.left = `${Math.min(x, window.innerWidth - rect.width - 8)}px`;
  el.style.top = `${Math.min(y, window.innerHeight - rect.height - 8)}px`;

  bindCtxWatcher();
}

/**
 * 点击菜单外部才关闭。
 * 关键：命中判断必须放在捕获阶段且不能误伤菜单内部 ——
 * 否则 mousedown 先把菜单藏起来，随后的 click 就落空了。
 */
let ctxWatcher = null;
function bindCtxWatcher() {
  if (ctxWatcher) return;
  ctxWatcher = (e) => {
    const el = $('#ctxMenu');
    if (el.hidden) return;
    if (el.contains(e.target)) return; // 菜单内部：交给按钮自己的 click
    hideCtx();
  };
  document.addEventListener('mousedown', ctxWatcher, true);
  window.addEventListener('blur', hideCtx);
}

function hideCtx() { $('#ctxMenu').hidden = true; }

/* ============================================================
   新建 / 编辑主机
   ============================================================ */
let authMode = 'password';

function openHostModal(host) {
  const isEdit = !!host;
  $('#hostModalTitle').textContent = isEdit ? '编辑连接' : '新建连接';
  $('#hfId').value = host ? host.id : '';
  $('#hfName').value = host ? host.name : '';
  $('#hfGroup').value = host ? host.group : '默认分组';
  $('#hfHost').value = host ? host.host : '';
  $('#hfPort').value = host ? host.port : '22';
  $('#hfUser').value = host ? host.username : 'root';
  $('#hfPassword').value = '';
  $('#hfKeyPath').value = host ? host.privateKeyPath || '' : '';
  $('#hfKeyContent').value = '';
  $('#hfPassphrase').value = '';
  $('#hfNote').value = host ? host.note : '';
  $('#testResult').textContent = '';
  $('#testResult').className = 'test-result';

  const groups = Array.from(new Set(state.hosts.map((h) => h.group).filter(Boolean)));
  $('#groupList').innerHTML = groups.map((g) => `<option value="${esc(g)}"></option>`).join('');

  setAuthMode(host && host.authType === 'key' ? 'key' : 'password');
  $('#hostModal').hidden = false;
  setTimeout(() => $('#hfName').focus(), 60);
}

function setAuthMode(mode) {
  authMode = mode;
  $$('#authSeg .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.auth === mode));
  $('#pwBlock').hidden = mode !== 'password';
  $('#keyBlock').hidden = mode !== 'key';
}

$$('#authSeg .seg-btn').forEach((b) => (b.onclick = () => setAuthMode(b.dataset.auth)));

$('#btnPickKey').onclick = async () => {
  const paths = await req(api.dialog.pickFiles());
  if (paths && paths[0]) $('#hfKeyPath').value = paths[0];
};

$('#hostModalClose').onclick = () => ($('#hostModal').hidden = true);
$('#hostModal').addEventListener('mousedown', (e) => {
  if (e.target.id === 'hostModal') $('#hostModal').hidden = true;
});

function collectHostForm() {
  return {
    id: $('#hfId').value || undefined,
    name: $('#hfName').value.trim(),
    group: $('#hfGroup').value.trim() || '默认分组',
    host: $('#hfHost').value.trim(),
    port: Number($('#hfPort').value) || 22,
    username: $('#hfUser').value.trim() || 'root',
    authType: authMode,
    password: $('#hfPassword').value,
    privateKeyPath: $('#hfKeyPath').value.trim(),
    privateKey: $('#hfKeyContent').value,
    passphrase: $('#hfPassphrase').value,
    note: $('#hfNote').value.trim()
  };
}

$('#btnTest').onclick = async () => {
  const h = collectHostForm();
  if (!h.host) return toast('请填写主机地址', 'warn');
  const box = $('#testResult');
  box.className = 'test-result';
  box.textContent = '正在连接…';
  try {
    const r = await req(api.hosts.test(h));
    box.className = 'test-result ok';
    box.textContent = `连接成功 · ${r.latency} ms`;
  } catch (err) {
    box.className = 'test-result err';
    box.textContent = `失败：${err.message}`;
  }
};

$('#hostForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const h = collectHostForm();
  if (!h.host) return toast('请填写主机地址', 'warn');
  try {
    const saved = await req(api.hosts.save(h));
    $('#hostModal').hidden = true;
    await loadHosts();
    toast('连接配置已保存', 'ok');
    selectHost(saved.id);
  } catch (err) {
    toast(`保存失败：${err.message}`, 'err');
  }
});

async function removeHost(host) {
  const okc = await confirmDialog('删除连接', `确定删除 <b>${esc(host.name)}</b> 吗？仅移除本机保存的配置，不会影响服务器。`, '删除');
  if (!okc) return;
  try {
    await req(api.hosts.remove(host.id));
    if (state.hostId === host.id) {
      state.hostId = null;
      state.host = null;
      $('#workspace').hidden = true;
      $('#emptyState').hidden = false;
    }
    await loadHosts();
    toast('已删除', 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
}

$('#btnAddHost').onclick = () => openHostModal(null);
$('#btnAddHostEmpty').onclick = () => openHostModal(null);

/* 托盘菜单「新建连接」 */
if (api.tray && api.tray.onNewHost) {
  api.tray.onNewHost(() => {
    try { if (typeof openHostModal === 'function') openHostModal(null); } catch (_) {}
  });
}

/* ============================================================
   快速连接面板
   ============================================================ */
let paletteSel = 0;
function openPalette() {
  $('#palette').hidden = false;
  const input = $('#paletteInput');
  input.value = '';
  renderPalette('');
  setTimeout(() => input.focus(), 40);
}
function closePalette() { $('#palette').hidden = true; }

function renderPalette(q) {
  const list = state.hosts.filter((h) =>
    !q || [h.name, h.host, h.username].some((v) => (v || '').toLowerCase().includes(q.toLowerCase()))
  );
  const box = $('#paletteList');
  if (!list.length) {
    box.innerHTML = `<div class="palette-empty">没有匹配的服务器 · 按 Enter 新建连接</div>`;
    paletteSel = -1;
    return;
  }
  box.innerHTML = list
    .map((h, i) => `<button class="palette-item ${i === 0 ? 'sel' : ''}" data-id="${h.id}">
      <div class="pi-ico">${esc((h.name || 'S').slice(0, 1).toUpperCase())}</div>
      <div><div class="pi-name">${esc(h.name)}</div><div class="pi-addr">${esc(h.username)}@${esc(h.host)}:${esc(h.port)}</div></div>
      <span style="font-size:10.5px;color:var(--t4)">${esc(h.group || '')}</span>
    </button>`)
    .join('');
  paletteSel = 0;
  $$('.palette-item', box).forEach((el, i) => {
    el.onclick = () => { closePalette(); selectHost(el.dataset.id); };
    el.onmouseenter = () => { paletteSel = i; $$('.palette-item', box).forEach((x, j) => x.classList.toggle('sel', j === i)); };
  });
}

$('#btnQuick').onclick = openPalette;
$('#paletteInput').addEventListener('input', (e) => renderPalette(e.target.value.trim()));
$('#paletteInput').addEventListener('keydown', (e) => {
  const items = $$('.palette-item', $('#paletteList'));
  if (e.key === 'Escape') return closePalette();
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!items.length) return;
    paletteSel = Math.max(0, Math.min(items.length - 1, paletteSel + (e.key === 'ArrowDown' ? 1 : -1)));
    items.forEach((x, j) => x.classList.toggle('sel', j === paletteSel));
    items[paletteSel].scrollIntoView({ block: 'nearest' });
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    if (items[paletteSel]) { items[paletteSel].click(); }
    else { closePalette(); openHostModal(null); }
  }
});
$('#palette').addEventListener('mousedown', (e) => {
  if (e.target.id === 'palette') closePalette();
});

/* ============================================================
   MCP 服务
   ============================================================ */
let mcpData = null;
let mcpCfgTab = 'cursor';
const mcpLogs = [];

async function copyText(text) {
  try {
    await req(api.clipboard.write(text));
    toast('已复制到剪贴板', 'ok', 1600);
  } catch (err) {
    toast(`复制失败：${err.message}`, 'err');
  }
}

function mcpConfigText() {
  if (!mcpData) return '';
  const url = mcpData.url || `http://127.0.0.1:${mcpData.configuredPort}/mcp`;
  const token = mcpData.token || '';
  if (mcpCfgTab === 'cursor') {
    return JSON.stringify(
      { mcpServers: { serverpilot: { url, headers: { Authorization: `Bearer ${token}` } } } },
      null,
      2
    );
  }
  return JSON.stringify(
    {
      mcpServers: {
        serverpilot: {
          command: 'npx',
          args: ['-y', 'mcp-remote', url, '--header', `Authorization: Bearer ${token}`]
        }
      }
    },
    null,
    2
  );
}

function renderMcpLogs() {
  const box = $('#mcpLogs');
  if (!mcpLogs.length) {
    box.innerHTML = `<div class="dim-text" style="padding:10px 8px">还没有客户端调用</div>`;
    $('#mcpCallCount').textContent = '0';
    return;
  }
  $('#mcpCallCount').textContent = String(mcpLogs.length);
  box.innerHTML = mcpLogs
    .map((l) => {
      const t = new Date(l.time);
      const p = (x) => String(x).padStart(2, '0');
      const detail = l.ok ? l.args || '' : l.error || '';
      return `<div class="mcp-log-row ${l.ok ? 'ok' : 'err'}">
        <span class="mcp-log-time">${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}</span>
        <span class="mcp-log-name">${esc(l.tool)}</span>
        <span class="mcp-log-detail" title="${esc(detail)}">${esc(detail)}</span>
        <span class="mcp-log-ms">${l.ms}ms</span>
      </div>`;
    })
    .join('');
}

function renderMcp() {
  if (!mcpData) return;
  const d = mcpData;
  $('#mcpDot').classList.toggle('on', !!d.running);
  $('#mcpSideDot').classList.toggle('on', !!d.running);
  $('#mcpSideInfo').textContent = d.running ? `127.0.0.1:${d.port}` : '未运行 · 点击开启';

  $('#mcpStateText').textContent = d.running ? '运行中' : d.enabled === false ? '已关闭' : '已停止';
  $('#mcpStateSub').textContent = d.running
    ? `${d.url} · ${d.toolCount} 个工具 · 已调用 ${d.calls} 次`
    : '服务未监听，AI 客户端无法接入';

  $('#mcpEnabled').checked = !!d.running;
  $('#mcpUrl').value = d.url || `http://127.0.0.1:${d.configuredPort}/mcp`;
  $('#mcpPort').value = d.running ? d.port : d.configuredPort;
  $('#mcpToken').textContent = d.token || '—';
  $('#mcpReadonly').checked = !!d.readonly;
  $('#mcpReadonlyLabel').textContent = d.readonly ? '已开启' : '已关闭';

  $('#mcpToolCount').textContent = String(d.tools ? d.tools.length : 0);
  $('#mcpTools').innerHTML = (d.tools || [])
    .map(
      (t) => `<div class="mcp-tool">
        <div class="mcp-tool-head"><b>${esc(t.name)}</b>${/^(read|list|system|connect)/.test(t.name) ? '<span class="ro-tag">只读</span>' : '<span class="ro-tag" style="color:#F0B36A;background:rgba(240,179,106,.10);border-color:rgba(240,179,106,.20)">写入</span>'}</div>
        <span>${esc(t.title)} · ${esc((t.description || '').slice(0, 34))}…</span>
      </div>`
    )
    .join('');

  $('#mcpConfig').textContent = mcpConfigText();
}

async function openMcp() {
  $('#mcpOverlay').hidden = false;
  try {
    mcpData = await req(api.mcp.info());
    renderMcp();
    renderMcpLogs();
  } catch (err) {
    toast(`读取 MCP 状态失败：${err.message}`, 'err');
  }
}

$('#btnMcp').onclick = openMcp;
$('#mcpClose').onclick = () => ($('#mcpOverlay').hidden = true);
$('#mcpOverlay').addEventListener('mousedown', (e) => {
  if (e.target.id === 'mcpOverlay') $('#mcpOverlay').hidden = true;
});

$('#mcpEnabled').addEventListener('change', async (e) => {
  const on = e.target.checked;
  try {
    mcpData = await req(on ? api.mcp.start() : api.mcp.stop());
    renderMcp();
    toast(on ? `MCP 服务已启动 · ${mcpData.url}` : 'MCP 服务已停止', on ? 'ok' : 'info', 2400);
  } catch (err) {
    toast(`MCP 服务操作失败：${err.message}`, 'err', 4800);
    try { mcpData = await req(api.mcp.info()); renderMcp(); } catch (_) {}
  }
});

$('#mcpApplyPort').onclick = async () => {
  const port = Number($('#mcpPort').value);
  if (!(port >= 1024 && port <= 65535)) return toast('端口需在 1024 - 65535 之间', 'warn');
  try {
    mcpData = await req(api.mcp.patch({ port }));
    if (mcpData.running) mcpData = await req(api.mcp.restart());
    renderMcp();
    toast(`已切换到端口 ${mcpData.port || port}`, 'ok');
  } catch (err) {
    toast(`修改端口失败：${err.message}`, 'err');
  }
};

$('#mcpReadonly').addEventListener('change', async (e) => {
  try {
    mcpData = await req(api.mcp.patch({ readonly: e.target.checked }));
    renderMcp();
    toast(e.target.checked ? '已开启只读模式' : '已关闭只读模式，AI 现在可以写入与执行命令', e.target.checked ? 'info' : 'warn', 3000);
  } catch (err) {
    toast(err.message, 'err');
  }
});

$('#mcpRotate').onclick = async () => {
  try {
    mcpData = await req(api.mcp.rotate());
    renderMcp();
    toast('访问令牌已重置，请在客户端更新配置', 'ok', 3000);
  } catch (err) {
    toast(err.message, 'err');
  }
};

$('#mcpCopyUrl').onclick = () => copyText($('#mcpUrl').value);
$('#mcpCopyToken').onclick = () => copyText(mcpData ? mcpData.token : '');
$('#mcpCopyCfg').onclick = () => copyText(mcpConfigText());

$$('#mcpSeg .seg-btn').forEach((b) => {
  b.onclick = () => {
    mcpCfgTab = b.dataset.cfg;
    $$('#mcpSeg .seg-btn').forEach((x) => x.classList.toggle('active', x === b));
    $('#mcpConfig').textContent = mcpConfigText();
  };
});

$('#mcpClearLog').onclick = () => { mcpLogs.length = 0; renderMcpLogs(); };

/* ============================================================
   全局快捷键 & 生命周期
   ============================================================ */
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    openPalette();
    return;
  }
  if (e.key === 'Escape') {
    if (!$('#palette').hidden) return closePalette();
    if (!$('#editorOverlay').hidden) return closeEditor(false);
    if (!$('#hostModal').hidden) return ($('#hostModal').hidden = true);
    if (!$('#mcpOverlay').hidden) return ($('#mcpOverlay').hidden = true);
    if (!$('#confirmModal').hidden) return resolveConfirm(false);
    if (!$('#promptModal').hidden) return resolvePrompt(null);
    hideCtx();
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && !$('#editorOverlay').hidden) {
    e.preventDefault();
    saveEditor();
  }
});

window.addEventListener('resize', () => {
  fitActiveTerm();
  hideCtx();
});

/* 概览定时刷新 */
setInterval(() => {
  if (state.tab === 'overview' && state.connected) loadOverview();
}, 30000);

/* 启动 */
(async function boot() {
  renderCmdChips();
  await loadHosts();
  await loadFavorites();
  await loadTemplates();
  try {
    mcpData = await req(api.mcp.info());
    renderMcp();
  } catch (_) {}
  api.mcp.onState((d) => {
    if (!d) return;
    mcpData = d;
    if (!$('#mcpOverlay').hidden) renderMcp();
  });
  api.mcp.onLog((entry) => {
    if (!entry) return;
    mcpLogs.unshift(entry);
    if (mcpLogs.length > 60) mcpLogs.pop();
    if (mcpData) mcpData.calls = (mcpData.calls || 0) + 1;
    renderMcpLogs();
    if (!mcpData || !mcpData.running) return;
  });
  if (state.hosts.length) {
    selectHost(state.hosts[0].id);
  }
})();

/* ---------------- 主题：深色 / 浅色 ---------------- */
function applyTheme(t, persist) {
  const light = t === 'light';
  document.documentElement.setAttribute('data-theme', light ? 'light' : 'dark');
  const btn = $('#btnTheme');
  if (btn) {
    btn.innerHTML = `<svg class="ic"><use href="#${light ? 'i-sun' : 'i-moon'}"/></svg>`;
    btn.title = light ? '切换深色模式' : '切换浅色模式';
  }
  termMap.forEach((rec) => {
    try {
      rec.term.options.theme = termTheme();
      if (rec.fit) rec.fit.fit();
    } catch (_) {}
  });
  if (persist) req(api.theme.set(light ? 'light' : 'dark')).catch(() => {});
}

applyTheme(api.theme.get() === 'light' ? 'light' : 'dark', false);

$('#btnTheme').onclick = () => {
  const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
  applyTheme(next, true);
  toast(next === 'light' ? '已切换到浅色模式' : '已切换到深色模式', 'info', 1800);
};

})();


