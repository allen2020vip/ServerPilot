'use strict';

const { Client } = require('ssh2');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const CONNECT_DEFAULTS = {
  readyTimeout: 25000,
  keepaliveInterval: 15000,
  keepaliveCountMax: 3,
  tryKeyboard: true,
  // 兼容老旧服务器（CentOS 6/7、老款交换机等）
  algorithms: {
    kex: [
      'curve25519-sha256', 'curve25519-sha256@libssh.org',
      'ecdh-sha2-nistp256', 'ecdh-sha2-nistp384', 'ecdh-sha2-nistp521',
      'diffie-hellman-group-exchange-sha256',
      'diffie-hellman-group14-sha256', 'diffie-hellman-group14-sha1',
      'diffie-hellman-group-exchange-sha1', 'diffie-hellman-group1-sha1'
    ],
    serverHostKey: [
      'ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521',
      'rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa', 'ssh-dss'
    ]
  }
};

class Connection {
  constructor(host, client) {
    this.host = host;
    this.client = client;
    this.state = 'ready';
    this.sftpSession = null;
    this._sftpPromise = null;
  }

  /* ---------------- shell ---------------- */

  openShell({ cols = 120, rows = 32, cwd }) {
    return new Promise((resolve, reject) => {
      const opts = { term: 'xterm-256color', cols, rows, env: { TERM: 'xterm-256color', COLORTERM: 'truecolor' } };
      this.client.shell(opts, (err, stream) => {
        if (err) return reject(err);
        resolve(stream);
      });
    });
  }

  execStream(command, cwd, onChunk) {
    const prefix = cwd ? `cd ${shq(cwd)} && ` : '';
    return new Promise((resolve, reject) => {
      this.client.exec(`${prefix}${command}`, { pty: false }, (err, stream) => {
        if (err) return reject(err);
        stream.on('data', (d) => onChunk('stdout', d.toString('utf8')));
        stream.stderr.on('data', (d) => onChunk('stderr', d.toString('utf8')));
        stream.on('close', (code) => resolve(code == null ? 0 : code));
        stream.on('error', reject);
      });
    });
  }

  /* ---------------- sftp ---------------- */

  _sftp() {
    if (this._sftpPromise) return this._sftpPromise;
    this._sftpPromise = new Promise((resolve, reject) => {
      this.client.sftp((err, sftp) => {
        if (err) { this._sftpPromise = null; return reject(err); }
        this.sftpSession = sftp;
        sftp.on('close', () => { this.sftpSession = null; this._sftpPromise = null; });
        resolve(sftp);
      });
    });
    return this._sftpPromise;
  }

  async realpath(p) {
    const sftp = await this._sftp();
    return new Promise((resolve, reject) => {
      sftp.realpath(p, (err, rp) => (err ? reject(err) : resolve(rp)));
    });
  }

  async stat(p) {
    const sftp = await this._sftp();
    return new Promise((resolve, reject) => {
      sftp.stat(p, (err, st) => (err ? reject(err) : resolve(st)));
    });
  }

  async list(dir) {
    const sftp = await this._sftp();
    let base = dir;
    try { base = await this.realpath(dir); } catch (_) {}
    const raw = await new Promise((resolve, reject) => {
      sftp.readdir(base, (err, list) => (err ? reject(err) : resolve(list)));
    });

    const entries = raw.map((e) => {
      const attrs = e.attrs || {};
      const mode = attrs.mode || 0;
      const typeBits = mode & 0o170000;
      const isLink = typeBits === 0o120000;
      const isDir = typeBits === 0o040000;
      return {
        name: e.filename,
        path: path.posix.join(base, e.filename),
        isDir,
        isLink,
        size: attrs.size || 0,
        mtime: (attrs.mtime || 0) * 1000,
        mode: mode & 0o777,
        modeText: toModeText(mode, isDir)
      };
    });

    entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name, 'zh-CN');
    });

    return {
      path: base,
      parent: base === '/' ? null : path.posix.dirname(base),
      entries
    };
  }

  async readFile(file) {
    const sftp = await this._sftp();
    const buf = await new Promise((resolve, reject) => {
      sftp.readFile(file, (err, data) => (err ? reject(err) : resolve(Buffer.from(data))));
    });

    if (buf.length > 8 * 1024 * 1024) {
      throw new Error('文件超过 8 MB，点击下载到本地后使用外部编辑器打开');
    }

    const binary = isBinary(buf);
    return {
      name: path.posix.basename(file),
      path: file,
      size: buf.length,
      binary,
      content: binary ? buf.toString('base64') : buf.toString('utf8')
    };
  }

  async writeFile(file, content, encoding) {
    const sftp = await this._sftp();
    const buf = encoding === 'base64' ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf8');
    return new Promise((resolve, reject) => {
      sftp.writeFile(file, buf, { mode: 0o644 }, (err) => (err ? reject(err) : resolve(true)));
    });
  }

  async mkdir(dir) {
    const sftp = await this._sftp();
    return new Promise((resolve, reject) => {
      sftp.mkdir(dir, { mode: 0o755 }, (err) => (err ? reject(err) : resolve(true)));
    });
  }

  /** 逐级创建目录（mkdir -p 语义） */
  async ensureDir(dir) {
    if (!dir || dir === '/' || dir === '.') return;
    const parts = dir.split('/').filter(Boolean);
    let cur = '';
    for (const p of parts) {
      cur += '/' + p;
      try { await this.mkdir(cur); } catch (_) {}
    }
  }

  async rename(from, to) {
    const sftp = await this._sftp();
    return new Promise((resolve, reject) => {
      sftp.rename(from, to, (err) => (err ? reject(err) : resolve(true)));
    });
  }

  async chmod(file, mode) {
    const sftp = await this._sftp();
    return new Promise((resolve, reject) => {
      sftp.chmod(file, mode, (err) => (err ? reject(err) : resolve(true)));
    });
  }

  async remove(p, isDir) {
    const sftp = await this._sftp();
    if (!isDir) {
      return new Promise((resolve, reject) => {
        sftp.unlink(p, (err) => (err ? reject(err) : resolve(true)));
      });
    }
    // 递归删除目录
    const list = await new Promise((resolve, reject) => {
      sftp.readdir(p, (err, l) => (err ? reject(err) : resolve(l)));
    });
    for (const e of list) {
      const childPath = path.posix.join(p, e.filename);
      const isDir = ((e.attrs.mode || 0) & 0o170000) === 0o040000;
      await this.remove(childPath, isDir).catch(() => {});
    }
    return new Promise((resolve, reject) => {
      sftp.rmdir(p, (err) => (err ? reject(err) : resolve(true)));
    });
  }

  async uploadFile(localPath, remotePath, onProgress) {
    const sftp = await this._sftp();
    const total = (await fsp.stat(localPath)).size;
    return new Promise((resolve, reject) => {
      const rs = fs.createReadStream(localPath);
      const ws = sftp.createWriteStream(remotePath, { mode: 0o644, autoClose: true });
      let sent = 0;
      rs.on('data', (c) => {
        sent += c.length;
        if (onProgress) {
          onProgress({
            kind: 'upload',
            name: path.basename(localPath),
            transferred: sent,
            total,
            percent: total ? Math.min(100, Math.round((sent / total) * 100)) : 100
          });
        }
      });
      rs.on('error', reject);
      ws.on('error', reject);
      ws.on('close', () => {
        if (onProgress) onProgress({ kind: 'upload', name: path.basename(localPath), transferred: total, total, percent: 100 });
        resolve(true);
      });
      rs.pipe(ws);
    });
  }

  async downloadFile(remotePath, localPath, onProgress) {
    const sftp = await this._sftp();
    const st = await this.stat(remotePath);
    const total = st.size || 0;
    await fsp.mkdir(path.dirname(localPath), { recursive: true });
    return new Promise((resolve, reject) => {
      const rs = sftp.createReadStream(remotePath);
      const ws = fs.createWriteStream(localPath);
      let got = 0;
      rs.on('data', (c) => {
        got += c.length;
        if (onProgress) {
          onProgress({
            kind: 'download',
            name: path.posix.basename(remotePath),
            transferred: got,
            total,
            percent: total ? Math.min(100, Math.round((got / total) * 100)) : 100
          });
        }
      });
      rs.on('error', reject);
      ws.on('error', reject);
      ws.on('close', () => resolve(true));
      rs.pipe(ws);
    });
  }

  async uploadDir(localDir, remoteDir, onProgress) {
    try { await this.ensureDir(remoteDir); } catch (_) {}
    const items = await fsp.readdir(localDir, { withFileTypes: true });
    for (const item of items) {
      const lp = path.join(localDir, item.name);
      const rp = remoteDir.replace(/\/+$/, '') + '/' + item.name;
      if (item.isDirectory()) await this.uploadDir(lp, rp, onProgress);
      else await this.uploadFile(lp, rp, onProgress);
    }
  }

  async downloadDir(remoteDir, localDir, onProgress) {
    await fsp.mkdir(localDir, { recursive: true });
    const listing = await this.list(remoteDir);
    for (const e of listing.entries) {
      const lp = path.join(localDir, e.name);
      if (e.isDir) await this.downloadDir(e.path, lp, onProgress);
      else await this.downloadFile(e.path, lp, onProgress);
    }
  }

  /* ---------------- 部署工具 ---------------- */

  async writeRemoteFile(remotePath, content, mode) {
    const sftp = await this._sftp();
    const dir = path.posix.dirname(remotePath);
    try { await this.ensureDir(dir); } catch (_) {}
    return new Promise((resolve, reject) => {
      sftp.writeFile(remotePath, Buffer.from(content, 'utf8'), { mode: mode || 0o644 }, (err) => (err ? reject(err) : resolve(true)));
    });
  }

  async execCollect(command, cwd) {
    const out = [];
    const code = await this.execStream(command, cwd, (stream, chunk) => out.push({ stream, chunk }));
    return { code, output: out.map((o) => o.chunk).join(''), entries: out };
  }
}

class ConnectionManager {
  constructor() {
    this.conns = new Map();
  }

  get(hostId) {
    return this.conns.get(hostId) || null;
  }

  async connect(host) {
    const existing = this.conns.get(host.id);
    if (existing && existing.state === 'ready') return existing;

    const client = new Client();
    const cfg = {
      ...CONNECT_DEFAULTS,
      host: host.host,
      port: Number(host.port) || 22,
      username: host.username || 'root'
    };

    if (host.authType === 'key' && host.privateKey) {
      cfg.privateKey = host.privateKey;
      if (host.passphrase) cfg.passphrase = host.passphrase;
    } else if (host.password) {
      cfg.password = host.password;
    }

    await new Promise((resolve, reject) => {
      let settled = false;
      client
        .on('ready', () => { if (!settled) { settled = true; resolve(); } })
        .on('keyboard-interactive', (name, instr, lang, prompts, finish) => {
          try { finish(prompts.map(() => cfg.password || '')); } catch (_) {}
        })
        .on('error', (err) => { if (!settled) { settled = true; reject(err); } })
        .connect(cfg);
    });

    const conn = new Connection(host, client);
    this.conns.set(host.id, conn);

    client.on('close', () => {
      conn.state = 'closed';
      this.conns.delete(host.id);
    });
    client.on('error', () => {});

    return conn;
  }

  async testConnection(host) {
    const client = new Client();
    const cfg = {
      ...CONNECT_DEFAULTS,
      readyTimeout: 12000,
      host: host.host,
      port: Number(host.port) || 22,
      username: host.username || 'root'
    };
    if (host.authType === 'key' && host.privateKey) {
      cfg.privateKey = host.privateKey;
      if (host.passphrase) cfg.passphrase = host.passphrase;
    } else if (host.password) {
      cfg.password = host.password;
    }
    await new Promise((resolve, reject) => {
      client
        .on('ready', resolve)
        .on('keyboard-interactive', (n, i, l, prompts, finish) => {
          try { finish(prompts.map(() => cfg.password || '')); } catch (_) {}
        })
        .on('error', reject)
        .connect(cfg);
    });
    client.end();
    return true;
  }

  close(hostId) {
    const c = this.conns.get(hostId);
    if (c) {
      try { c.client.end(); } catch (_) {}
      this.conns.delete(hostId);
    }
  }

  closeAll() {
    for (const [, c] of this.conns) {
      try { c.client.end(); } catch (_) {}
    }
    this.conns.clear();
  }
}

function shq(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

function toModeText(mode, isDir) {
  const type = isDir ? 'd' : '-';
  const bits = ['r', 'w', 'x'];
  let out = type;
  for (let shift = 6; shift >= 0; shift -= 3) {
    const v = (mode >> shift) & 7;
    out += (v & 4 ? 'r' : '-') + (v & 2 ? 'w' : '-') + (v & 1 ? 'x' : '-');
  }
  return out;
}

function isBinary(buf) {
  if (!buf || buf.length === 0) return false;
  const sample = buf.length > 4096 ? buf.subarray(0, 4096) : buf;
  let suspicious = 0;
  for (let i = 0; i < sample.length; i++) {
    const b = sample[i];
    if (b === 0) return true;
    if (b < 7 || (b > 13 && b < 32)) suspicious++;
  }
  return suspicious / sample.length > 0.15;
}

module.exports = ConnectionManager;
