'use strict';

const path = require('path');
const templates = require('./templates');

/**
 * 顺序执行部署步骤，实时回传日志
 */
class Deployer {
  constructor(manager) {
    this.manager = manager;
  }

  async run(conn, plan, hooks) {
    const steps = plan.steps || [];
    const total = steps.length;
    const privileged = plan.privileged && (conn.host.username !== 'root');
    let failed = 0;

    hooks.log({ level: 'section', text: `开始部署 · 共 ${total} 个步骤 · 目标 ${conn.host.host}` });

    for (let i = 0; i < total; i++) {
      const step = steps[i];
      const tag = `[${i + 1}/${total}]`;
      hooks.progress({ done: i, total, current: step.label });
      hooks.log({ level: 'step', text: `${tag} ${step.label}` });
      const t0 = Date.now();

      try {
        if (step.type === 'command') {
          let cmd = step.command;
          if (privileged) cmd = `sudo -n bash -lc ${shq(cmd)}`;
          const res = await conn.execCollect(cmd, step.cwd);
          for (const entry of res.entries) {
            const text = entry.chunk.replace(/\s+$/, '');
            if (text) hooks.log({ level: entry.stream === 'stderr' ? 'warn' : 'out', text });
          }
          if (res.code !== 0) {
            hooks.log({ level: 'warn', text: `${tag} 命令退出码 ${res.code}` });
            failed++;
            if (step.fatal) throw new Error(`步骤失败：${step.label}`);
          } else {
            hooks.log({ level: 'ok', text: `${tag} 完成 · ${((Date.now() - t0) / 1000).toFixed(1)}s` });
          }
        } else if (step.type === 'write') {
          await conn.writeRemoteFile(step.remotePath, step.content, step.mode);
          hooks.log({ level: 'ok', text: `写入 ${step.remotePath}` });
        } else if (step.type === 'upload') {
          const st = require('fs').statSync(step.localPath);
          const onP = (p) => hooks.log({ level: 'out', text: `${p.kind === 'upload' ? '↑' : '↓'} ${p.name} ${p.percent}%` });
          if (st.isDirectory()) {
            await conn.uploadDir(step.localPath, step.remotePath, onP);
          } else {
            await conn.uploadFile(step.localPath, step.remotePath, onP);
          }
          hooks.log({ level: 'ok', text: `上传完成 → ${step.remotePath}` });
        } else if (step.type === 'mkdir') {
          await conn.mkdir(step.remotePath);
          hooks.log({ level: 'ok', text: `创建目录 ${step.remotePath}` });
        }
      } catch (err) {
        failed++;
        hooks.log({ level: 'error', text: `${tag} 失败：${err.message}` });
      }
    }

    hooks.progress({ done: total, total, current: '完成' });
    hooks.log({
      level: failed ? 'warn' : 'ok',
      text: failed ? `部署结束 · ${failed} 个步骤出现异常，请检查上方日志` : '部署成功 · 所有步骤已完成'
    });

    return { failed };
  }
}

function shq(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

module.exports = Deployer;
