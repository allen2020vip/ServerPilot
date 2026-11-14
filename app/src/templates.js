'use strict';

/**
 * 部署模板：metadata 可序列化，steps 由 build() 生成
 */

const templates = [
  {
    id: 'static-site',
    badge: 'NG',
    name: '静态站点',
    subtitle: 'Nginx + 本地目录同步',
    category: 'Web',
    accent: '#3B82F6',
    fields: [
      { key: 'domain', label: '域名 / 站点标识', type: 'text', default: 'example.com', placeholder: 'app.example.com' },
      { key: 'root', label: '服务器站点目录', type: 'text', default: '/var/www/site', placeholder: '/var/www/site' },
      { key: 'localDir', label: '本地待上传目录', type: 'folder', default: '' },
      { key: 'ssl', label: '启用 443 端口监听', type: 'bool', default: false }
    ],
    build(v) {
      const root = v.root || '/var/www/site';
      const domain = v.domain || 'example.com';
      const nginxConf = `server {
    listen 80;
    ${v.ssl ? 'listen 443 ssl;' : ''}
    server_name ${domain};

    root ${root};
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location ~* \\.(js|css|png|jpg|jpeg|gif|svg|woff2?|ttf|ico)$ {
        expires 30d;
        add_header Cache-Control "public, immutable";
    }

    gzip on;
    gzip_types text/css application/javascript application/json image/svg+xml;
    gzip_min_length 1024;
}
`;
      const steps = [
        { type: 'command', label: '检查 Nginx 是否安装', command: 'nginx -v 2>&1 || (apt-get update -y && apt-get install -y nginx) || (yum install -y nginx)' },
        { type: 'command', label: `创建站点目录 ${root}`, command: `mkdir -p ${root}` },
        { type: 'write', label: `写入 Nginx 配置 ${domain}.conf`, remotePath: `/etc/nginx/conf.d/${domain}.conf`, content: nginxConf },
        { type: 'command', label: '校验 Nginx 配置', command: 'nginx -t' },
        { type: 'command', label: '重载 Nginx', command: 'systemctl reload nginx 2>/dev/null || nginx -s reload' }
      ];
      if (v.localDir) {
        steps.push({ type: 'upload', label: `上传本地目录 → ${root}`, localPath: v.localDir, remotePath: root, overwrite: true });
      }
      steps.push({ type: 'command', label: '设置目录权限', command: `chown -R www-data:www-data ${root} 2>/dev/null || chown -R nginx:nginx ${root} 2>/dev/null || true` });
      return steps;
    }
  },

  {
    id: 'node-app',
    badge: 'JS',
    name: 'Node.js 应用',
    subtitle: 'PM2 守护 · 依赖安装 · 热重启',
    category: 'Runtime',
    accent: '#22C55E',
    fields: [
      { key: 'appName', label: '应用名称', type: 'text', default: 'node-app' },
      { key: 'root', label: '服务器部署目录', type: 'text', default: '/opt/node-app' },
      { key: 'localDir', label: '本地项目目录', type: 'folder', default: '' },
      { key: 'entry', label: '入口文件 / 启动命令', type: 'text', default: 'index.js' },
      { key: 'port', label: '监听端口', type: 'text', default: '3000' }
    ],
    build(v) {
      const root = v.root || '/opt/node-app';
      const name = v.appName || 'node-app';
      const steps = [
        { type: 'command', label: '检查 Node.js 环境', command: 'node -v || (curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs)' },
        { type: 'command', label: '安装 PM2', command: 'pm2 -v || npm install -g pm2' },
        { type: 'command', label: `创建目录 ${root}`, command: `mkdir -p ${root}` }
      ];
      if (v.localDir) steps.push({ type: 'upload', label: '上传项目文件', localPath: v.localDir, remotePath: root, overwrite: true });
      steps.push(
        { type: 'command', label: '安装依赖', command: 'npm ci --omit=dev || npm install --omit=dev', cwd: root },
        { type: 'command', label: `启动 / 重启 ${name}`, command: `pm2 describe ${name} >/dev/null 2>&1 && pm2 restart ${name} --update-env || PORT=${v.port || 3000} pm2 start ${v.entry || 'index.js'} --name ${name}`, cwd: root },
        { type: 'command', label: '保存进程列表', command: 'pm2 save' },
        { type: 'command', label: '状态', command: `pm2 status ${name}` }
      );
      return steps;
    }
  },

  {
    id: 'docker-compose',
    badge: 'DK',
    name: 'Docker Compose',
    subtitle: '容器化一键编排',
    category: 'Container',
    accent: '#0EA5E9',
    fields: [
      { key: 'root', label: '服务器部署目录', type: 'text', default: '/opt/docker-app' },
      { key: 'localFile', label: '本地 compose 文件', type: 'file', default: '' },
      { key: 'compose', label: '或粘贴 compose 内容', type: 'textarea', default: 'services:\n  web:\n    image: nginx:alpine\n    ports:\n      - "8080:80"\n    restart: always\n' }
    ],
    build(v) {
      const root = v.root || '/opt/docker-app';
      const steps = [
        { type: 'command', label: '检查 Docker', command: 'docker -v || (curl -fsSL https://get.docker.com | sh)' },
        { type: 'command', label: '检查 Compose 插件', command: 'docker compose version || (apt-get install -y docker-compose-plugin 2>/dev/null || true)' },
        { type: 'command', label: `创建目录 ${root}`, command: `mkdir -p ${root}` }
      ];
      if (v.localFile) {
        steps.push({ type: 'upload', label: '上传 compose 文件', localPath: v.localFile, remotePath: `${root}/docker-compose.yml` });
      } else {
        steps.push({ type: 'write', label: '写入 docker-compose.yml', remotePath: `${root}/docker-compose.yml`, content: v.compose || '' });
      }
      steps.push(
        { type: 'command', label: '拉取镜像并启动', command: 'docker compose up -d --pull always', cwd: root },
        { type: 'command', label: '容器状态', command: 'docker compose ps', cwd: root }
      );
      return steps;
    }
  },

  {
    id: 'systemd-service',
    badge: 'SD',
    name: 'Systemd 服务',
    subtitle: '二进制 / 脚本常驻守护',
    category: 'Runtime',
    accent: '#A855F7',
    fields: [
      { key: 'service', label: '服务名称', type: 'text', default: 'myapp' },
      { key: 'exec', label: '启动命令', type: 'text', default: '/opt/myapp/myapp' },
      { key: 'cwd', label: '工作目录', type: 'text', default: '/opt/myapp' },
      { key: 'user', label: '运行用户', type: 'text', default: 'root' }
    ],
    build(v) {
      const service = v.service || 'myapp';
      const unit = `[Unit]
Description=${service} service
After=network.target

[Service]
Type=simple
WorkingDirectory=${v.cwd || '/opt/myapp'}
ExecStart=${v.exec || '/opt/myapp/myapp'}
Restart=always
RestartSec=5
User=${v.user || 'root'}
LimitNOFILE=65535
StandardOutput=append:/var/log/${service}.log
StandardError=append:/var/log/${service}.error.log

[Install]
WantedBy=multi-user.target
`;
      return [
        { type: 'write', label: `写入 /etc/systemd/system/${service}.service`, remotePath: `/etc/systemd/system/${service}.service`, content: unit },
        { type: 'command', label: '重载 systemd', command: 'systemctl daemon-reload' },
        { type: 'command', label: '启用并启动服务', command: `systemctl enable --now ${service}` },
        { type: 'command', label: '服务状态', command: `systemctl --no-pager status ${service} | head -n 20` }
      ];
    }
  },

  {
    id: 'reverse-proxy',
    badge: 'RP',
    name: 'Nginx 反向代理',
    subtitle: '域名 → 后端端口',
    category: 'Web',
    accent: '#F59E0B',
    fields: [
      { key: 'domain', label: '域名', type: 'text', default: 'app.example.com' },
      { key: 'upstream', label: '后端地址', type: 'text', default: '127.0.0.1:3000' },
      { key: 'ws', label: '开启 WebSocket', type: 'bool', default: true },
      { key: 'ssl', label: '签发 Let\'s Encrypt 证书', type: 'bool', default: false }
    ],
    build(v) {
      const conf = `server {
    listen 80;
    server_name ${v.domain};

    client_max_body_size 100m;

    location / {
        proxy_pass http://${v.upstream};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        ${v.ws ? 'proxy_set_header Upgrade $http_upgrade;\n        proxy_set_header Connection "upgrade";\n        proxy_read_timeout 3600s;' : ''}
    }
}
`;
      const steps = [
        { type: 'command', label: '检查 Nginx', command: 'nginx -v || (apt-get update -y && apt-get install -y nginx)' },
        { type: 'write', label: `写入 ${v.domain}.conf`, remotePath: `/etc/nginx/conf.d/${v.domain}.conf`, content: conf },
        { type: 'command', label: '校验配置', command: 'nginx -t' },
        { type: 'command', label: '重载 Nginx', command: 'systemctl reload nginx' }
      ];
      if (v.ssl) {
        steps.push({ type: 'command', label: '申请证书', command: `command -v certbot || (apt-get install -y certbot python3-certbot-nginx); certbot --nginx -d ${v.domain} --non-interactive --agree-tos -m admin@${v.domain} --redirect` });
      }
      return steps;
    }
  },

  {
    id: 'server-init',
    badge: 'OS',
    name: '服务器初始化',
    subtitle: '基础环境 + 安全基线',
    category: 'Ops',
    accent: '#EF4444',
    fields: [
      { key: 'timezone', label: '时区', type: 'text', default: 'Asia/Shanghai' },
      { key: 'tools', label: '预装工具 (空格分隔)', type: 'text', default: 'git curl wget vim htop unzip ufw' },
      { key: 'sshPort', label: 'SSH 端口', type: 'text', default: '22' },
      { key: 'swap', label: '创建 2G Swap', type: 'bool', default: false }
    ],
    build(v) {
      const tools = (v.tools || '').trim();
      const steps = [
        { type: 'command', label: '系统信息', command: 'cat /etc/os-release | head -n 3; uname -r; nproc; free -h | head -n 2' },
        { type: 'command', label: '更新软件源', command: 'apt-get update -y || yum makecache -y' },
        { type: 'command', label: '安装常用工具', command: `apt-get install -y ${tools} || yum install -y ${tools}` },
        { type: 'command', label: `设置时区 ${v.timezone}`, command: `timedatectl set-timezone ${v.timezone} 2>/dev/null || (ln -sf /usr/share/zoneinfo/${v.timezone} /etc/localtime && echo "${v.timezone}" > /etc/timezone)` },
        { type: 'command', label: '开启防火墙', command: `ufw allow ${v.sshPort}/tcp 2>/dev/null; ufw allow 80/tcp 2>/dev/null; ufw allow 443/tcp 2>/dev/null; ufw --force enable 2>/dev/null || true` },
        { type: 'command', label: '开启 BBR 拥塞控制', command: `grep -q "net.ipv4.tcp_congestion_control" /etc/sysctl.conf || echo "net.ipv4.tcp_congestion_control=bbr" >> /etc/sysctl.conf; sysctl -p 2>/dev/null || true` }
      ];
      if (v.swap) {
        steps.push({ type: 'command', label: '创建 2G Swap', command: 'test -f /swapfile || (fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile && echo "/swapfile none swap sw 0 0" >> /etc/fstab)' });
      }
      steps.push({ type: 'command', label: '完成检查', command: 'free -h; df -h /' });
      return steps;
    }
  }
];

function list() {
  return templates.map(({ build, ...meta }) => meta);
}

function buildById(id, values) {
  const tpl = templates.find((t) => t.id === id);
  if (!tpl) throw new Error('模板不存在: ' + id);
  return tpl.build(values || {});
}

module.exports = { list, buildById, raw: templates };
