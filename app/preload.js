'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

const dropListeners = [];
window.addEventListener('drop', (e) => {
  try {
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
    const paths = files
      .map((f) => { try { return webUtils.getPathForFile(f); } catch (_) { return ''; } })
      .filter(Boolean);
    if (paths.length) dropListeners.forEach((cb) => { try { cb(paths); } catch (_) {} });
  } catch (_) {}
}, true);

const on = (channel, handler) => {
  const wrapped = (_e, payload) => handler(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
};

contextBridge.exposeInMainWorld('api', {
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close: () => ipcRenderer.send('window:close'),
    isMaximized: () => invoke('window:isMaximized'),
    onState: (cb) => on('window:state', cb)
  },

  hosts: {
    list: () => invoke('hosts:list'),
    save: (host) => invoke('hosts:save', host),
    remove: (id) => invoke('hosts:delete', id),
    test: (host) => invoke('hosts:test', host)
  },

  conn: {
    open: (hostId) => invoke('conn:open', hostId),
    close: (hostId) => invoke('conn:close', hostId),
    status: (hostId) => invoke('conn:status', hostId)
  },

  favorites: {
    list: () => invoke('favorites:list'),
    add: (fav) => invoke('favorites:add', fav),
    remove: (id) => invoke('favorites:remove', id)
  },

  shell: {
    open: (payload) => invoke('shell:open', payload),
    write: (payload) => ipcRenderer.send('shell:write', payload),
    resize: (payload) => ipcRenderer.send('shell:resize', payload),
    close: (payload) => ipcRenderer.send('shell:close', payload),
    onData: (cb) => on('shell:data', cb),
    onExit: (cb) => on('shell:exit', cb)
  },

  files: {
    list: (p) => invoke('sftp:list', p),
    home: (p) => invoke('sftp:home', p),
    read: (p) => invoke('sftp:read', p),
    save: (p) => invoke('sftp:save', p),
    mkdir: (p) => invoke('sftp:mkdir', p),
    rename: (p) => invoke('sftp:rename', p),
    remove: (p) => invoke('sftp:delete', p),
    chmod: (p) => invoke('sftp:chmod', p),
    upload: (p) => invoke('sftp:upload', p),
    download: (p) => invoke('sftp:download', p),
    exists: (p) => invoke('sftp:exists', p)
  },

  exec: {
    run: (p) => invoke('exec:run', p),
    cancel: (p) => invoke('exec:cancel', p),
    onOutput: (cb) => on('exec:output', cb),
    onDone: (cb) => on('exec:done', cb)
  },

  deploy: {
    templates: () => invoke('deploy:templates'),
    run: (p) => invoke('deploy:run', p),
    onLog: (cb) => on('deploy:log', cb),
    onProgress: (cb) => on('deploy:progress', cb)
  },

  dialog: {
    pickFiles: () => invoke('dialog:pickFiles'),
    pickFolder: () => invoke('dialog:pickFolder'),
    saveFile: (p) => invoke('dialog:saveFile', p)
  },

  system: {
    openLocal: (p) => invoke('shell:openLocal', p),
    paths: () => invoke('app:paths')
  },

  clipboard: {
    write: (t) => invoke('clipboard:write', t)
  },

  theme: {
    get: () => ipcRenderer.sendSync('theme:get'),
    set: (t) => invoke('theme:set', t)
  },

  tray: {
    onNewHost: (cb) => on('tray:new-host', cb)
  },

  transfer: {
    onProgress: (cb) => on('transfer:progress', cb)
  },

  mcp: {
    info: () => invoke('mcp:info'),
    start: () => invoke('mcp:start'),
    stop: () => invoke('mcp:stop'),
    patch: (p) => invoke('mcp:patch', p),
    restart: () => invoke('mcp:restart'),
    rotate: () => invoke('mcp:rotate'),
    onState: (cb) => on('mcp:state', cb),
    onLog: (cb) => on('mcp:log', cb)
  },

  onFileDrop: (cb) => { dropListeners.push(cb); }
});
