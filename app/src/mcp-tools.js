'use strict';

/**
 * MCP 工具集 —— 把 ServerPilot 的服务器能力暴露给 AI 客户端。
 * 每个工具都是一次完整的“连接 → 操作 → 返回文本”流程。
 */

const path = require('path');

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
  String(out).split(/\r?\n/).forEach((line) => {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) map[m[1]] = m[2].trim();
  });
  return map;
}

const fmtBytes = (n) => {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  let x = v;
  do { x /= 1024; i++; } while (x >= 1024 && i < u.length - 1);
  return `${x.toFixed(x < 10 ? 1 : 0)} ${u[i]}`;
};

const j = (o) => JSON.stringify(o, null, 2);

function buildTools(ctx) {
  const { store, manager, deployer, templates } = ctx;

  /** 解析目标主机：host_id 可省略（仅有一台时自动选中） */
  function resolveHost(args) {
    const hosts = store.listHosts();
    if (!hosts.length) throw new Error('还没有配置任何服务器，请先在 ServerPilot 中添加连接');
    let id = args && args.host_id;
    if (!id) {
      if (hosts.length === 1) id = hosts[0].id;
      else {
        throw new Error(
          `存在 ${hosts.length} 台服务器，请显式传 host_id。可选：` +
          hosts.map((h) => `${h.id}(${h.name})`).join('、')
        );
      }
    }
    const host = hosts.find((h) => h.id === id);
    if (!host) throw new Error(`未找到 host_id=${id} 的服务器`);
    return host;
  }

  async function getConn(args) {
    const host = resolveHost(args);
    const resolved = store.getHostForConnect(host.id);
    const c = await manager.connect(resolved);
    return { host, conn: c };
  }

  const HOST_ID_SCHEMA = {
    type: 'string',
    description: '目标服务器 ID（list_hosts 返回的 id）。只配置了一台时可省略。'
  };

  const tools = [
    {
      name: 'list_hosts',
      title: '列出服务器',
      readonly: true,
      description: '列出 ServerPilot 中已配置的所有服务器及其连接状态。调用其他工具前先用它获取 host_id。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async run() {
        const hosts = store.listHosts().map((h) => {
          const c = manager.get(h.id);
          return {
            id: h.id,
            name: h.name,
            host: h.host,
            port: h.port,
            username: h.username,
            group: h.group,
            note: h.note || undefined,
            connected: !!(c && c.state === 'ready')
          };
        });
        if (!hosts.length) return '当前没有任何服务器。请先在 ServerPilot 界面中新建连接。';
        return j(hosts);
      }
    },
    {
      name: 'connect_host',
      title: '连接服务器',
      readonly: true,
      description: '与指定服务器建立 SSH 连接（幂等，已连接会直接复用）。返回主机名与系统信息。',
      inputSchema: {
        type: 'object',
        properties: { host_id: HOST_ID_SCHEMA },
        required: ['host_id'],
        additionalProperties: false
      },
      async run(args) {
        const { host, conn } = await getConn(args);
        return `已连接 ${host.name}（${host.username}@${host.host}:${host.port}）`;
      }
    },
    {
      name: 'system_overview',
      title: '系统概览',
      readonly: true,
      description: '采集目标服务器的 CPU、内存、磁盘、负载、运行时长、系统版本等运行指标。',
      inputSchema: {
        type: 'object',
        properties: { host_id: HOST_ID_SCHEMA },
        required: ['host_id'],
        additionalProperties: false
      },
      async run(args) {
        const { host, conn } = await getConn(args);
        const r = await conn.execCollect(SYS_CMD);
        const kv = parseKV(r.output);
        if (!kv.MEMTOTAL) {
          return `采集失败，命令退出码 ${r.code}。\n${String(r.output).slice(0, 800)}`;
        }
        return j({
          host: host.name,
          hostname: kv.HOSTNAME,
          os: kv.OS,
          kernel: kv.KERNEL,
          arch: kv.ARCH,
          cpu_cores: Number(kv.CPUCORES) || null,
          cpu_percent: Number(kv.CPUUSAGE) || 0,
          load: kv.LOAD,
          memory: { used: fmtBytes(Number(kv.MEMUSED) * 1024 * 1024), total: fmtBytes(Number(kv.MEMTOTAL) * 1024 * 1024) },
          disk: { used: fmtBytes(Number(kv.DISKUSED) * 1024 * 1024), total: fmtBytes(Number(kv.DISKTOTAL) * 1024 * 1024), percent: Number(kv.DISKPCT) || 0 },
          uptime: kv.UPTIME,
          ip: kv.IP,
          sampled_at: kv.TIME
        });
      }
    },
    {
      name: 'list_dir',
      title: '列目录',
      readonly: true,
      description: '列出远程目录内容（名称、类型、大小、权限、修改时间）。path 省略时为登录用户的家目录。',
      inputSchema: {
        type: 'object',
        properties: {
          host_id: HOST_ID_SCHEMA,
          path: { type: 'string', description: '远程绝对路径，如 /var/www' }
        },
        required: ['host_id'],
        additionalProperties: false
      },
      async run(args) {
        const { conn, host } = await getConn(args);
        let target = args.path;
        if (!target) target = await conn.realpath('.');
        const dir = await conn.list(target);
        const rows = dir.entries
          .filter((e) => e.name !== '.' && e.name !== '..')
          .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
          .map((e) => ({
            name: e.name,
            type: e.isDir ? 'dir' : e.isLink ? 'link' : 'file',
            size: e.isDir ? null : e.size,
            mode: e.modeText,
            mtime: e.mtime ? new Date(e.mtime).toISOString() : null
          }));
        return j({ host: host.name, path: dir.path || target, count: rows.length, entries: rows });
      }
    },
    {
      name: 'read_file',
      title: '读取文件',
      readonly: true,
      description: '读取远程文本文件内容。二进制文件会返回提示。单文件上限 8 MB。',
      inputSchema: {
        type: 'object',
        properties: {
          host_id: HOST_ID_SCHEMA,
          path: { type: 'string', description: '远程绝对路径' }
        },
        required: ['host_id', 'path'],
        additionalProperties: false
      },
      async run(args) {
        const { conn } = await getConn(args);
        const f = await conn.readFile(args.path);
        if (f.binary) {
          return `文件 ${args.path} 是二进制（${fmtBytes(f.size)}），不返回内容。如需下载请在界面操作。`;
        }
        const content = f.content.length > 200000 ? f.content.slice(0, 200000) + '\n…（已截断，共 ' + fmtBytes(f.size) + '）' : f.content;
        return `路径：${args.path}\n大小：${fmtBytes(f.size)}\n\n${content}`;
      }
    },
    {
      name: 'write_file',
      title: '写入文件',
      readonly: false,
      description: '创建或覆盖远程文本文件（UTF-8），父目录不存在时自动创建。修改前建议先 read_file 备份。',
      inputSchema: {
        type: 'object',
        properties: {
          host_id: HOST_ID_SCHEMA,
          path: { type: 'string', description: '远程绝对路径' },
          content: { type: 'string', description: '完整文件内容（会覆盖原文件）' },
          mode: { type: 'string', description: '可选八进制权限，如 644 / 755' }
        },
        required: ['host_id', 'path', 'content'],
        additionalProperties: false
      },
      async run(args) {
        const { conn } = await getConn(args);
        await conn.writeRemoteFile(args.path, args.content, args.mode ? parseInt(args.mode, 8) : undefined);
        return `已写入 ${args.path}（${fmtBytes(Buffer.byteLength(args.content, 'utf8'))}）`;
      }
    },
    {
      name: 'make_dir',
      title: '创建目录',
      readonly: false,
      description: '递归创建远程目录（mkdir -p 语义）。',
      inputSchema: {
        type: 'object',
        properties: { host_id: HOST_ID_SCHEMA, path: { type: 'string' } },
        required: ['host_id', 'path'],
        additionalProperties: false
      },
      async run(args) {
        const { conn } = await getConn(args);
        await conn.ensureDir(args.path);
        return `已创建目录 ${args.path}`;
      }
    },
    {
      name: 'move_path',
      title: '重命名 / 移动',
      readonly: false,
      description: '重命名或移动远程文件/目录。',
      inputSchema: {
        type: 'object',
        properties: {
          host_id: HOST_ID_SCHEMA,
          from: { type: 'string', description: '源路径' },
          to: { type: 'string', description: '目标路径' }
        },
        required: ['host_id', 'from', 'to'],
        additionalProperties: false
      },
      async run(args) {
        const { conn } = await getConn(args);
        await conn.rename(args.from, args.to);
        return `已把 ${args.from} 移动到 ${args.to}`;
      }
    },
    {
      name: 'delete_path',
      title: '删除路径',
      readonly: false,
      description: '删除远程文件或目录。目录需显式传 recursive=true 才会递归删除，请谨慎使用。',
      inputSchema: {
        type: 'object',
        properties: {
          host_id: HOST_ID_SCHEMA,
          path: { type: 'string' },
          recursive: { type: 'boolean', description: '目录是否递归删除，默认 false' }
        },
        required: ['host_id', 'path'],
        additionalProperties: false
      },
      async run(args) {
        const { conn } = await getConn(args);
        const st = await conn.stat(args.path);
        const isDir = st.isDirectory();
        if (isDir && !args.recursive) throw new Error(`${args.path} 是目录，需传 recursive=true 才能删除`);
        await conn.remove(args.path, isDir);
        return `已删除 ${isDir ? '目录' : '文件'} ${args.path}`;
      }
    },
    {
      name: 'exec_command',
      title: '执行命令',
      readonly: false,
      description: '在远程服务器执行单条 Shell 命令并返回 stdout/stderr 与退出码。适合查看日志、重启服务、查看进程等。默认超时 60 秒。',
      inputSchema: {
        type: 'object',
        properties: {
          host_id: HOST_ID_SCHEMA,
          command: { type: 'string', description: '要执行的 Shell 命令' },
          cwd: { type: 'string', description: '可选工作目录' },
          timeout_ms: { type: 'integer', description: '超时毫秒，默认 60000，最大 300000' }
        },
        required: ['host_id', 'command'],
        additionalProperties: false
      },
      async run(args) {
        const { conn } = await getConn(args);
        const limit = Math.min(Math.max(Number(args.timeout_ms) || 60000, 1000), 300000);
        let timer;
        const timeout = new Promise((resolve) => {
          timer = setTimeout(() => resolve({ timedOut: true }), limit);
        });
        const res = await Promise.race([conn.execCollect(args.command, args.cwd), timeout]);
        clearTimeout(timer);
        if (res.timedOut) return `命令在 ${limit} ms 内未结束，已放弃等待（远端可能仍在执行）。`;
        const out = String(res.output || '');
        const body = out.length > 30000 ? out.slice(0, 30000) + '\n…（输出已截断）' : out;
        return `退出码：${res.code}\n\n${body || '(无输出)'}`;
      }
    },
    {
      name: 'list_templates',
      title: '列出部署模板',
      readonly: true,
      description: '列出内置部署模板的 id、名称、说明与参数，供 deploy_template 使用。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async run() {
        const list = templates.list().map((t) => ({
          id: t.id,
          name: t.name,
          desc: t.desc,
          badge: t.badge,
          fields: (t.fields || []).map((f) => ({
            key: f.key,
            label: f.label,
            type: f.type,
            required: !!f.required,
            default: f.default !== undefined ? f.default : undefined
          }))
        }));
        return j(list);
      }
    },
    {
      name: 'deploy_template',
      title: '执行部署模板',
      readonly: false,
      description: '在目标服务器上执行内置部署模板（会真实执行命令，可能重启服务）。values 为模板参数字典，privileged=true 时通过 sudo 执行。',
      inputSchema: {
        type: 'object',
        properties: {
          host_id: HOST_ID_SCHEMA,
          template_id: { type: 'string', description: 'list_templates 返回的 id' },
          values: { type: 'object', description: '模板参数，如 {"domain":"example.com","root":"/var/www/site"}' },
          privileged: { type: 'boolean', description: '是否使用 sudo 执行，默认 false' }
        },
        required: ['host_id', 'template_id'],
        additionalProperties: false
      },
      async run(args) {
        const { conn } = await getConn(args);
        const steps = templates.buildById(args.template_id, args.values || {});
        const logs = [];
        await deployer.run(conn, { planId: args.template_id, steps, privileged: !!args.privileged }, {
          log: (entry) => logs.push(`[${entry.level}] ${entry.text}`),
          progress: () => {}
        });
        return `部署完成（${args.template_id}），共 ${steps.length} 个步骤。\n\n` + logs.join('\n');
      }
    }
  ];

  return {
    list: () =>
      tools.map((t) => ({
        name: t.name,
        title: t.title,
        description: t.description,
        inputSchema: t.inputSchema
      })),
    isMutating: (name) => {
      const t = tools.find((x) => x.name === name);
      return t ? t.readonly === false : true;
    },
    has: (name) => tools.some((t) => t.name === name),
    call: async (name, args) => {
      const t = tools.find((x) => x.name === name);
      if (!t) throw new Error(`未知工具：${name}`);
      const a = args || {};
      for (const key of t.inputSchema.required || []) {
        if (a[key] === undefined || a[key] === null || a[key] === '') {
          throw new Error(`缺少必填参数：${key}`);
        }
      }
      return await t.run(a);
    }
  };
}

module.exports = { buildTools, SYS_CMD, parseKV };
