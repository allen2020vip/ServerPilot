'use strict';

/**
 * MCP 服务端 —— Model Context Protocol (2025-06-18) / Streamable HTTP。
 * 仅监听 127.0.0.1，Bearer Token 鉴权，可被 Cursor / Claude Desktop(mcp-remote) / 自建 Agent 直接接入。
 */

const http = require('http');
const os = require('os');

const SERVER_INFO = { name: 'serverpilot', title: 'ServerPilot', version: '1.0.0' };
const PROTOCOL_VERSION = '2025-06-18';

class McpServer {
  constructor(opts) {
    this.tools = opts.tools;
    this.getToken = opts.getToken;
    this.getReadonly = opts.getReadonly;
    this.onLog = opts.onLog || (() => {});
    this.server = null;
    this.port = null;
    this.sessions = new Set();
    this.startedAt = null;
    this.calls = 0;
    this.lastError = null;
  }

  get running() {
    return !!this.server && this.server.listening;
  }

  state() {
    return {
      running: this.running,
      port: this.port,
      url: this.port ? `http://127.0.0.1:${this.port}/mcp` : null,
      healthUrl: this.port ? `http://127.0.0.1:${this.port}/health` : null,
      readonly: this.getReadonly(),
      toolCount: this.tools.list().length,
      calls: this.calls,
      startedAt: this.startedAt,
      host: `${os.hostname()}`
    };
  }

  /** 从 preferred 端口开始，最多尝试 12 个端口 */
  async start(preferredPort) {
    await this.stop();
    const base = Number(preferredPort) || 8787;
    let lastErr = null;
    for (let i = 0; i < 12; i++) {
      const port = base + i;
      try {
        await this._listen(port);
        this.port = port;
        this.startedAt = Date.now();
        return this.state();
      } catch (err) {
        lastErr = err;
        if (err.code !== 'EADDRINUSE') break;
      }
    }
    this.lastError = lastErr ? lastErr.message : '启动失败';
    throw new Error(this.lastError);
  }

  _listen(port) {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this._handle(req, res));
      server.on('error', (err) => {
        server.close(() => {});
        reject(err);
      });
      server.on('clientError', (_e, socket) => { try { socket.destroy(); } catch (_) {} });
      server.listen(port, '127.0.0.1', () => {
        this.server = server;
        resolve();
      });
    });
  }

  async stop() {
    const s = this.server;
    this.server = null;
    this.port = null;
    this.sessions.clear();
    if (!s) return;
    await new Promise((resolve) => {
      try { s.close(() => resolve()); } catch (_) { resolve(); }
      setTimeout(resolve, 800);
    });
  }

  /* ------------------------------------------------------------------ */
  /* HTTP                                                                */
  /* ------------------------------------------------------------------ */

  _cors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id, Accept, MCP-Protocol-Version');
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
  }

  _json(res, code, obj, extra) {
    this._cors(res);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...(extra || {}) });
    res.end(JSON.stringify(obj));
  }

  _auth(req) {
    const token = this.getToken();
    if (!token) return false;
    const h = String(req.headers.authorization || '');
    const m = h.match(/^Bearer\s+(.+)$/i);
    return !!m && m[1].trim() === token;
  }

  _handle(req, res) {
    const url = (req.url || '').split('?')[0];

    if (req.method === 'OPTIONS') {
      this._cors(res);
      res.writeHead(204);
      return res.end();
    }

    if (url === '/health') {
      return this._json(res, 200, {
        status: 'ok',
        name: SERVER_INFO.name,
        version: SERVER_INFO.version,
        protocol: PROTOCOL_VERSION,
        tools: this.tools.list().length,
        readonly: this.getReadonly()
      });
    }

    if (url !== '/mcp' && url !== '/') {
      return this._json(res, 404, { error: 'not found' });
    }

    if (!this._auth(req)) {
      return this._json(res, 401, { error: 'unauthorized', hint: '需要在 Authorization 头里携带 Bearer Token' });
    }

    if (req.method === 'GET') {
      // Streamable HTTP 的 SSE 通道：本项目所有请求均为即时响应，返回 405 让客户端回退到 POST
      return this._json(res, 405, { error: 'method not allowed', hint: '请使用 POST 发送 JSON-RPC 请求' });
    }

    if (req.method !== 'POST') {
      return this._json(res, 405, { error: 'method not allowed' });
    }

    let raw = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) {
        try { req.destroy(); } catch (_) {}
        return;
      }
      raw += chunk;
    });
    req.on('end', async () => {
      let body;
      try {
        body = JSON.parse(raw || '{}');
      } catch (_) {
        return this._json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      }

      const sid = req.headers['mcp-session-id'];
      const extra = sid ? { 'Mcp-Session-Id': sid } : {};

      if (Array.isArray(body)) {
        const results = [];
        for (const item of body) results.push(await this._dispatch(item, res));
        return this._json(res, 200, results, extra);
      }

      const result = await this._dispatch(body, res);
      if (result === null) {
        // notification：按规范返回 202 无内容
        res.writeHead(202);
        return res.end();
      }
      const headers = { ...extra };
      if (result.__session) headers['Mcp-Session-Id'] = result.__session;
      delete result.__session;
      return this._json(res, 200, result, headers);
    });
  }

  /* ------------------------------------------------------------------ */
  /* JSON-RPC                                                            */
  /* ------------------------------------------------------------------ */

  async _dispatch(msg, res) {
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') {
      return { jsonrpc: '2.0', id: msg && msg.id !== undefined ? msg.id : null, error: { code: -32600, message: 'Invalid Request' } };
    }
    const id = msg.id;
    const method = msg.method;
    const params = msg.params || {};

    if (id === undefined) {
      // notifications/initialized / cancelled 等，无需响应
      return null;
    }

    try {
      switch (method) {
        case 'initialize': {
          const sid = require('crypto').randomUUID();
          this.sessions.add(sid);
          return {
            __session: sid,
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: PROTOCOL_VERSION,
              capabilities: {
                tools: { listChanged: false },
                logging: {}
              },
              serverInfo: SERVER_INFO,
              instructions:
                'ServerPilot 提供远程服务器管理能力：列目录、读写文件、执行命令、部署模板。' +
                '先用 list_hosts 获取 host_id；涉及写操作前先用 read_file 确认现状。'
            }
          };
        }

        case 'ping':
          return { jsonrpc: '2.0', id, result: {} };

        case 'tools/list':
          return { jsonrpc: '2.0', id, result: { tools: this.tools.list() } };

        case 'tools/call': {
          const name = params.name;
          const args = params.arguments || {};
          if (!this.tools.has(name)) {
            return { jsonrpc: '2.0', id, error: { code: -32602, message: `未知工具：${name}` } };
          }
          if (this.tools.isMutating(name) && this.getReadonly()) {
            return {
              jsonrpc: '2.0',
              id,
              result: {
                content: [{ type: 'text', text: '当前 MCP 服务处于只读模式，写操作与命令执行已被拒绝。可在 ServerPilot 的 MCP 面板关闭只读模式。' }],
                isError: true
              }
            };
          }
          const t0 = Date.now();
          try {
            const text = await this.tools.call(name, args);
            this.calls++;
            const ms = Date.now() - t0;
            this.onLog({ time: Date.now(), tool: name, ok: true, ms, args: summarize(args) });
            return {
              jsonrpc: '2.0',
              id,
              result: { content: [{ type: 'text', text: String(text) }], isError: false }
            };
          } catch (err) {
            const ms = Date.now() - t0;
            this.onLog({ time: Date.now(), tool: name, ok: false, ms, args: summarize(args), error: err.message });
            return {
              jsonrpc: '2.0',
              id,
              result: { content: [{ type: 'text', text: `执行失败：${err.message}` }], isError: true }
            };
          }
        }

        case 'resources/list':
          return { jsonrpc: '2.0', id, result: { resources: [] } };

        case 'prompts/list':
          return { jsonrpc: '2.0', id, result: { prompts: [] } };

        default:
          return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
      }
    } catch (err) {
      return { jsonrpc: '2.0', id, error: { code: -32603, message: err.message } };
    }
  }
}

function summarize(args) {
  try {
    const s = JSON.stringify(args || {});
    return s.length > 120 ? s.slice(0, 120) + '…' : s;
  } catch (_) {
    return '';
  }
}

module.exports = { McpServer, SERVER_INFO, PROTOCOL_VERSION };
