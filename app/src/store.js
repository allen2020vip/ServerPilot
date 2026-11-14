'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { safeStorage } = require('electron');

const ALGO = 'aes-256-gcm';

function machineKey(file) {
  try {
    if (fs.existsSync(file)) {
      return Buffer.from(fs.readFileSync(file, 'utf8'), 'hex');
    }
  } catch (_) {}
  const key = crypto.randomBytes(32);
  fs.writeFileSync(file, key.toString('hex'), { mode: 0o600 });
  return key;
}

class Store {
  constructor(file) {
    this.file = file;
    this.data = { version: 1, hosts: [], settings: {}, history: [], favorites: [] };
    this.keyFile = path.join(path.dirname(file), '.spkey');
    this._load();
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.hosts)) this.data = { ...this.data, ...parsed };
    } catch (_) {
      this._persist();
    }
  }

  _persist() {
    const dir = path.dirname(this.file);
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
  }

  _encrypt(text) {
    if (!text) return '';
    try {
      if (safeStorage && safeStorage.isEncryptionAvailable()) {
        return 'os:' + safeStorage.encryptString(text).toString('base64');
      }
    } catch (_) {}
    const key = machineKey(this.keyFile);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGO, key, iv);
    const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return 'aes:' + Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
  }

  _decrypt(payload) {
    if (!payload) return '';
    try {
      if (payload.startsWith('os:')) {
        return safeStorage.decryptString(Buffer.from(payload.slice(3), 'base64'));
      }
      if (payload.startsWith('aes:')) {
        const buf = Buffer.from(payload.slice(4), 'base64');
        const iv = buf.subarray(0, 12);
        const tag = buf.subarray(12, 28);
        const body = buf.subarray(28);
        const key = machineKey(this.keyFile);
        const decipher = crypto.createDecipheriv(ALGO, key, iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
      }
    } catch (_) {}
    return payload;
  }

  /* ---------- 对外 ---------- */

  listHosts() {
    return this.data.hosts.map((h) => {
      const { password, privateKey, passphrase, ...safe } = h;
      return {
        ...safe,
        hasPassword: !!password,
        hasKey: !!privateKey,
        hasPassphrase: !!passphrase
      };
    });
  }

  getRaw(id) {
    return this.data.hosts.find((h) => h.id === id) || null;
  }

  getHostForConnect(id) {
    const raw = this.getRaw(id);
    if (!raw) return null;
    const out = { ...raw };
    out.password = this._decrypt(raw.password);
    out.passphrase = this._decrypt(raw.passphrase);
    out.privateKey = raw.privateKey ? this._decrypt(raw.privateKey) : '';
    if (raw.privateKeyPath && fs.existsSync(raw.privateKeyPath)) {
      try { out.privateKey = fs.readFileSync(raw.privateKeyPath, 'utf8'); } catch (_) {}
    }
    return out;
  }

  resolveHostSecrets(host) {
    const existing = host.id ? this.getRaw(host.id) : null;
    const out = { ...host };
    out.password = host.password ? host.password : this._decrypt(existing && existing.password);
    out.passphrase = host.passphrase ? host.passphrase : this._decrypt(existing && existing.passphrase);
    out.privateKey = host.privateKey ? host.privateKey : (existing && existing.privateKey ? this._decrypt(existing.privateKey) : '');
    if (!out.privateKey && out.privateKeyPath && fs.existsSync(out.privateKeyPath)) {
      try { out.privateKey = fs.readFileSync(out.privateKeyPath, 'utf8'); } catch (_) {}
    }
    return out;
  }

  saveHost(host) {
    const existing = host.id ? this.getRaw(host.id) : null;
    const id = host.id || crypto.randomUUID();
    const record = {
      id,
      name: (host.name || '').trim() || host.host,
      host: (host.host || '').trim(),
      port: Number(host.port) || 22,
      username: (host.username || 'root').trim(),
      authType: host.authType || 'password',
      privateKeyPath: host.privateKeyPath || '',
      color: host.color || '#3B82F6',
      group: host.group || '默认分组',
      note: host.note || '',
      createdAt: existing ? existing.createdAt : Date.now(),
      updatedAt: Date.now(),
      lastConnectedAt: existing ? existing.lastConnectedAt : null
    };

    // 密码：新值加密，空值则沿用旧值
    if (host.password) record.password = this._encrypt(host.password);
    else if (existing && existing.password) record.password = existing.password;

    if (host.passphrase) record.passphrase = this._encrypt(host.passphrase);
    else if (existing && existing.passphrase) record.passphrase = existing.passphrase;

    if (host.privateKey) record.privateKey = this._encrypt(host.privateKey);
    else if (existing && existing.privateKey) record.privateKey = existing.privateKey;

    if (existing) {
      const idx = this.data.hosts.findIndex((h) => h.id === id);
      this.data.hosts[idx] = record;
    } else {
      this.data.hosts.push(record);
    }
    this._persist();
    return this.listHosts().find((h) => h.id === id);
  }

  deleteHost(id) {
    this.data.hosts = this.data.hosts.filter((h) => h.id !== id);
    this._persist();
    return true;
  }

  touch(id) {
    const h = this.getRaw(id);
    if (h) {
      h.lastConnectedAt = Date.now();
      this._persist();
    }
  }

  settings() {
    return { ...(this.data.settings || {}) };
  }

  setSetting(key, value) {
    if (!this.data.settings) this.data.settings = {};
    this.data.settings[key] = value;
    this._persist();
    return value;
  }

  /* ---------- 收藏夹 ---------- */

  listFavorites() {
    return (this.data.favorites || []).slice();
  }

  addFavorite(fav) {
    if (!Array.isArray(this.data.favorites)) this.data.favorites = [];
    const hostId = fav.hostId || '';
    const p = (fav.path || '').trim();
    if (!hostId || !p) throw new Error('收藏参数不完整');
    const existing = this.data.favorites.find((f) => f.hostId === hostId && f.path === p);
    if (existing) return existing;
    const record = {
      id: crypto.randomUUID(),
      hostId,
      path: p,
      name: (fav.name || '').trim() || p.split('/').filter(Boolean).pop() || p,
      isDir: !!fav.isDir,
      addedAt: Date.now()
    };
    this.data.favorites.push(record);
    this._persist();
    return record;
  }

  removeFavorite(id) {
    this.data.favorites = (this.data.favorites || []).filter((f) => f.id !== id);
    this._persist();
    return true;
  }
}

module.exports = Store;
