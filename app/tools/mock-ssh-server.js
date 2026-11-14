'use strict';
/**
 * 本地 SSH 测试服务器（仅用于开发验证，不参与打包）
 * 启动: node tools/mock-ssh-server.js
 * 账号: test / test   端口: 2222
 * SFTP 根目录映射到 tools/mockroot
 */
const { Server, utils } = require('ssh2');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 2222;
const USER = 'test';
const PASS = 'test';
const VROOT = '/testroot';
const LOCAL_ROOT = path.join(__dirname, 'mockroot');

fs.mkdirSync(LOCAL_ROOT, { recursive: true });

const keys = utils.generateKeyPairSync('ed25519');

function toLocal(p) {
  let clean = path.posix.normalize(String(p || '.')).replace(/\\/g, '/');
  if (!clean.startsWith(VROOT)) clean = VROOT + '/' + clean.replace(/^\/+/, '');
  const rel = clean.slice(VROOT.length).replace(/^\/+/, '');
  const local = path.join(LOCAL_ROOT, rel);
  if (!local.startsWith(LOCAL_ROOT)) return LOCAL_ROOT;
  return local;
}

const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;

function attrsOf(st) {
  const type = st.isDirectory() ? S_IFDIR : S_IFREG;
  return {
    mode: type | (st.isDirectory() ? 0o755 : 0o644),
    uid: 0,
    gid: 0,
    size: st.size,
    atime: Math.floor(st.atimeMs / 1000),
    mtime: Math.floor(st.mtimeMs / 1000)
  };
}

const server = new Server({ hostKeys: [keys.private] }, (client) => {
  client.on('authentication', (ctx) => {
    if (ctx.method === 'password' && ctx.username === USER && ctx.password === PASS) return ctx.accept();
    if (ctx.method === 'none') return ctx.accept();
    ctx.reject(['password']);
  });

  client.on('ready', () => {
    client.on('session', (accept) => {
      const session = accept();

      session.on('pty', (accept2, reject2) => accept2());
      session.on('window-change', (accept2, reject2) => accept2 && accept2());

      session.on('shell', (accept2) => {
        const stream = accept2();
        const proc = spawn('powershell.exe', ['-NoLogo', '-NoProfile'], { stdio: ['pipe', 'pipe', 'pipe'] });
        stream.on('data', (d) => { try { proc.stdin.write(d); } catch (_) {} });
        proc.stdout.on('data', (d) => stream.write(d));
        proc.stderr.on('data', (d) => stream.write(d));
        proc.on('exit', () => { try { stream.exit(0); stream.end(); } catch (_) {} });
        stream.on('close', () => { try { proc.kill(); } catch (_) {} });
        setTimeout(() => stream.write('Welcome to mock ssh (PowerShell backend)\r\n'), 300);
      });

      session.on('exec', (accept, reject, info) => {
        const stream = accept();
        const cmd = info.command;

        if (cmd.includes('CPUUSAGE')) {
          stream.write(
            [
              'HOSTNAME=mock-node-01',
              'OS=Ubuntu 22.04.3 LTS',
              'KERNEL=5.15.0-91-generic',
              'ARCH=x86_64',
              'CPUCORES=8',
              'UPTIME=12 days, 4 hours',
              'LOAD=0.42 0.38 0.31',
              'MEMTOTAL=15992',
              'MEMUSED=6120',
              'DISKTOTAL=102400',
              'DISKUSED=34816',
              'DISKPCT=34',
              'IP=10.0.0.12',
              'TIME=' + new Date().toISOString().slice(0, 19).replace('T', ' '),
              'CPUUSAGE=23',
              ''
            ].join('\n')
          );
          stream.exit(0);
          return stream.end();
        }

        const proc = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', cmd], { stdio: ['ignore', 'pipe', 'pipe'] });
        proc.stdout.on('data', (d) => stream.write(d));
        proc.stderr.on('data', (d) => stream.stderr.write(d));
        proc.on('exit', (code) => { stream.exit(code == null ? 0 : code); stream.end(); });
        proc.on('error', (e) => { stream.stderr.write(String(e.message)); stream.exit(1); stream.end(); });
      });

      session.on('sftp', (accept) => {
        const sftp = accept();
        const handles = new Map();
        let seq = 1;

        const addHandle = (obj) => {
          const id = Buffer.from(String(seq++));
          handles.set(id.toString('hex'), obj);
          return id;
        };
        const getHandle = (id) => handles.get(id.toString('hex'));

        sftp.on('REALPATH', (reqid, p) => {
          let clean = path.posix.normalize(p === '.' ? VROOT : p.replace(/\\/g, '/'));
          if (!clean.startsWith(VROOT)) clean = VROOT + '/' + clean.replace(/^\/+/, '');
          sftp.name(reqid, [{ filename: clean, longname: clean, attrs: {} }]);
        });

        sftp.on('STAT', (reqid, p) => {
          try { sftp.attrs(reqid, attrsOf(fs.statSync(toLocal(p)))); }
          catch (e) { sftp.status(reqid, 2); }
        });
        sftp.on('LSTAT', (reqid, p) => {
          try { sftp.attrs(reqid, attrsOf(fs.statSync(toLocal(p)))); }
          catch (e) { sftp.status(reqid, 2); }
        });

        sftp.on('OPEN', (reqid, filename, flags) => {
          const local = toLocal(filename);
          const mode = flags & 0x2 ? (flags & 0x10 ? 'w' : 'a') : 'r';
          try {
            const fd = fs.openSync(local, mode);
            const h = addHandle({ fd, local });
            sftp.handle(reqid, h);
          } catch (e) { sftp.status(reqid, 2); }
        });

        sftp.on('READ', (reqid, handle, offset, length) => {
          const h = getHandle(handle);
          if (!h || h.fd == null) return sftp.status(reqid, 4);
          try {
            const buf = Buffer.alloc(length);
            const n = fs.readSync(h.fd, buf, 0, length, offset);
            if (n <= 0) return sftp.status(reqid, 1);
            sftp.data(reqid, buf.subarray(0, n));
          } catch (e) { sftp.status(reqid, 4); }
        });

        sftp.on('WRITE', (reqid, handle, offset, data) => {
          const h = getHandle(handle);
          if (!h || h.fd == null) return sftp.status(reqid, 4);
          try {
            fs.writeSync(h.fd, Buffer.from(data), 0, data.length, offset);
            sftp.status(reqid, 0);
          } catch (e) { sftp.status(reqid, 4); }
        });

        sftp.on('FSTAT', (reqid, handle) => {
          const h = getHandle(handle);
          if (!h) return sftp.status(reqid, 4);
          try { sftp.attrs(reqid, attrsOf(fs.statSync(h.local))); }
          catch (e) { sftp.status(reqid, 2); }
        });

        sftp.on('FSETSTAT', (reqid, handle, attrs) => {
          const h = getHandle(handle);
          try {
            if (h && attrs.mode) fs.chmodSync(h.local, attrs.mode & 0o777);
            sftp.status(reqid, 0);
          } catch (e) { sftp.status(reqid, 4); }
        });

        sftp.on('SETSTAT', (reqid, p, attrs) => {
          try {
            if (attrs.mode) fs.chmodSync(toLocal(p), attrs.mode & 0o777);
            sftp.status(reqid, 0);
          } catch (e) { sftp.status(reqid, 4); }
        });

        sftp.on('CLOSE', (reqid, handle) => {
          const h = getHandle(handle);
          if (h && h.fd != null) { try { fs.closeSync(h.fd); } catch (_) {} }
          handles.delete(handle.toString('hex'));
          sftp.status(reqid, 0);
        });

        sftp.on('OPENDIR', (reqid, p) => {
          try {
            const local = toLocal(p);
            const items = fs.readdirSync(local, { withFileTypes: true });
            const entries = items.map((it) => {
              const lp = path.join(local, it.name);
              const st = fs.statSync(lp);
              const isDir = it.isDirectory();
              return {
                filename: it.name,
                longname: `${isDir ? 'd' : '-'}rwxr-xr-x 1 root root ${isDir ? 4096 : st.size} ${new Date(st.mtimeMs).toUTCString()} ${it.name}`,
                attrs: attrsOf(st)
              };
            });
            sftp.handle(reqid, addHandle({ entries, pos: 0 }));
          } catch (e) { sftp.status(reqid, 2); }
        });

        sftp.on('READDIR', (reqid, handle) => {
          const h = getHandle(handle);
          if (!h || !h.entries) return sftp.status(reqid, 4);
          const batch = h.entries.slice(h.pos, h.pos + 40);
          h.pos += batch.length;
          if (!batch.length) return sftp.status(reqid, 1);
          sftp.name(reqid, batch);
          sftp.status(reqid, 0);
        });

        sftp.on('MKDIR', (reqid, p) => {
          try { fs.mkdirSync(toLocal(p)); sftp.status(reqid, 0); }
          catch (e) { sftp.status(reqid, 4); }
        });

        sftp.on('RMDIR', (reqid, p) => {
          try { fs.rmdirSync(toLocal(p)); sftp.status(reqid, 0); }
          catch (e) { sftp.status(reqid, 4); }
        });

        sftp.on('REMOVE', (reqid, p) => {
          try { fs.unlinkSync(toLocal(p)); sftp.status(reqid, 0); }
          catch (e) { sftp.status(reqid, 4); }
        });

        sftp.on('RENAME', (reqid, from, to) => {
          try { fs.renameSync(toLocal(from), toLocal(to)); sftp.status(reqid, 0); }
          catch (e) { sftp.status(reqid, 4); }
        });
      });
    });
  });

  client.on('error', () => {});
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-ssh] listening on 127.0.0.1:${PORT}  user=${USER} pass=${PASS} root=${LOCAL_ROOT}`);
});
