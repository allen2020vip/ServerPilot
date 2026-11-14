# ServerPilot · 服务器管理与部署工作台

一款面向运维日常的 Windows 桌面工具：以 SSH/SFTP 为核心，把 **连接管理、系统监控、文件传输、在线编辑、一键部署** 收进一个界面里。深色 / 浅色双主题，克制、面向长时间使用设计。

![platform](https://img.shields.io/badge/platform-Windows%2010%2F11-14171D)
![electron](https://img.shields.io/badge/Electron-33-14171D)
![ssh2](https://img.shields.io/badge/ssh2-1.16-14171D)
![license](https://img.shields.io/badge/license-private-14171D)

---

## 获取与构建

**免安装使用**：直接下载 [Releases · ServerPilot 1.0.0](https://github.com/allen2020vip/ServerPilot/releases/download/v1.0.0/ServerPilot-1.0.0-portable.exe) 的 `ServerPilot-1.0.0-portable.exe`（71.96 MB），双击即可运行，无需安装。

仓库只收录源码，不含打包产物（`dist/` 与 `node_modules/` 已在 `.gitignore` 中排除）。

```powershell
git clone https://github.com/allen2020vip/ServerPilot.git
cd ServerPilot\app
npm install
npm start              # 开发运行
npm run dist           # 生成 dist\ServerPilot-1.0.0-portable.exe
```

国内网络可先配置镜像：

```powershell
npm config set registry https://registry.npmmirror.com
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
```

技术栈：Electron 33 · ssh2 1.16 · @xterm/xterm 5.5 · CodeMirror 5.65 · electron-builder 25（portable 目标）。界面无框架，纯手写 HTML/CSS/JS，单文件 IIFE。

---

## 快速开始

1. 双击运行 `dist\ServerPilot-1.0.0-portable.exe`（免安装，可直接拷到任意 Windows 10/11 机器），或从 [Releases](https://github.com/allen2020vip/ServerPilot/releases) 下载同款便携版。
2. 点击左下角 **新建连接**，填写主机地址、端口、用户名与密码（或选择私钥认证）。
3. 点击 **测试连接** 确认可达，保存后软件会自动连接并加载系统概览。
4. 顶部五个标签：**概览 / 文件 / 终端 / 部署 / 命令**。

> **关窗不等于退出**：右上角关闭按钮只是收进系统托盘，程序继续在后台运行（SSH 连接与 MCP 服务保持）。单击/双击托盘图标可重新打开窗口；托盘图标右键 → **退出** 才是真正结束进程。已在运行的便携版再次双击 exe 不会开出第二个实例（多开被拦截），唤回窗口请点托盘图标。

> 凭据只保存在本机 `%APPDATA%\ServerPilot\serverpilot.json`，密码与私钥经 Windows 系统级密钥（DPAPI）加密，不会以明文落盘，也不会外传。

---

## 功能

### 连接管理
- 密码认证、私钥认证（支持私钥文件路径或直接粘贴私钥内容 + passphrase）
- 兼容老旧服务器：内置 `ssh-rsa`、`diffe-hellman-group14-sha1` 等历史算法
- 连接保活（15s keepalive）、键盘交互式认证回退
- 侧栏搜索、右键菜单（连接 / 编辑 / 删除）、`Ctrl+K` 快速切换
- **行内连接按钮**：每台服务器右侧一枚胶囊按钮，未连接为绿色「连接」，点击即连；已连接变红色「断开」，点击即断
  - 连接过程中按钮显示「连接中」并禁用，避免重复点击
  - 断开后概览页指标（CPU / 内存 / 磁盘 / 运行时长）、系统信息表、服务状态列表全部清零回到占位，文件页回到「未连接」提示
  - 重连时保留原来的标签页与目录，连接成功后直接回到断开的路径
  - 顶栏「断开」与行内按钮走同一套逻辑

### 外观与主题
- 深色 / 浅色双主题，标题栏右上角一键切换，选择持久化到本机配置，重启后保持
- 两套主题共用同一套设计变量（背景色阶、边框、文字层级、阴影、悬停态），不是简单反色
- 跟随切换的还有：CodeMirror 编辑器配色（浅色为 Atom One Light 体系）、xterm 终端 16 色表、右键菜单与浮动层、Toast 与模态遮罩
- 首帧采用配置中的主题渲染，切到浅色模式不会先闪一下深色

### 系统概览
- 实时采集 CPU 使用率（两次采样）、内存、磁盘、负载、运行时长
- 系统信息表：发行版、内核、架构、内网 IP、CPU 核心数
- 服务状态扫描：nginx / docker / mysql / postgresql / redis / ssh / ufw
- 每 30 秒自动刷新，可手动刷新
- 快捷操作：打开终端、浏览文件、**收藏夹**、部署应用、进程排行、**重启服务器**
  - 重启为危险操作：先二次确认（公示主机名与账号），再前置校验权限（root 或免密 sudo），无权限直接拦下并提示
  - 下发后置为「重启中」，约 26 秒起每 6.5 秒探测一次，恢复后自动重连并刷新概览（最多等待约 2 分钟）

### 文件管理（SFTP）
- 目录浏览、面包屑跳转、文件权限与修改时间
- **表头排序**：点「名称 / 大小 / 权限 / 修改时间」可排序，再点一次反向；升序/降序用高亮三角指示，目录恒排在文件前面，名称按自然序（`file2` < `file10`），排序方式本地记忆
- 上传：按钮选择文件，或直接把文件/文件夹**拖进窗口**
- 下载：选择目录后落盘，支持整目录递归
- 新建文件夹、重命名、修改八进制权限、删除（目录递归）
- **收藏**：右键文件或文件夹 → 收藏，文件列表里显示星标；概览页「快捷操作 → 收藏夹」集中管理，点一下即可跳回该目录或直接打开文件（跨服务器会自动连接）
- 传输进度浮层，实时百分比

### 在线编辑器
- 双击文件即可打开，CodeMirror 语法高亮（sh / js / json / html / css / xml / yaml / nginx / python）
- `Ctrl+S` 保存回服务器，光标行列与保存状态实时提示
- 二进制文件自动识别，提示改用下载

### 终端
- 基于 xterm.js 的 256 色交互终端，支持窗口自适应（resize 同步到远端）
- 多标签：可同时开多个 Shell，右键关闭
- 一键清屏、新建终端

### 部署中心
内置 6 套模板，参数化执行，步骤日志实时回传：

| 模板 | 作用 |
| --- | --- |
| 静态站点 | Nginx 建站 + 本地目录上传 + 缓存与 gzip 配置 |
| Node.js 应用 | Node 环境、依赖安装、PM2 守护与重启 |
| Docker Compose | 写入/上传 compose 文件并 `up -d` |
| Systemd 服务 | 生成 unit 文件、enable 并启动 |
| Nginx 反向代理 | 域名反代 + WebSocket + 可选 Let's Encrypt |
| 服务器初始化 | 源更新、常用工具、时区、防火墙、BBR、Swap |

- 非 root 用户可勾选 **sudo 模式**，命令自动以 `sudo -n` 执行（需配置免密 sudo）
- 日志按级别着色：步骤 / 输出 / 警告 / 错误 / 完成

### 命令中心
- 单条命令执行，输出流式显示（stdout / stderr 分色）
- 常用命令快捷芯片：磁盘、内存、服务状态、端口监听、进程排行

### MCP 服务（AI 客户端接入）

内置一个标准的 **MCP（Model Context Protocol）服务端**，走 Streamable HTTP，AI 客户端可以直接把 ServerPilot 当作“服务器操作工具”调用。

- 入口：侧栏底部 **MCP 服务** 状态条 → 点击打开面板
- 默认监听 `127.0.0.1:8787`，只绑定回环地址，外部网络无法访问
- 鉴权：`Authorization: Bearer <令牌>`，令牌随机生成、保存在本机配置，可一键重置
- **只读模式**默认开启：只允许读取；关闭后 AI 才能写文件、删除、执行命令
- 面板内含客户端配置片段（可复制）、工具清单与调用记录

提供的工具（12 个）：

| 工具 | 类型 | 说明 |
| --- | --- | --- |
| `list_hosts` | 只读 | 列出已配置服务器与连接状态 |
| `connect_host` | 只读 | 建立 SSH 连接（幂等） |
| `system_overview` | 只读 | CPU / 内存 / 磁盘 / 负载 / 系统版本 |
| `list_dir` | 只读 | 列远程目录 |
| `read_file` | 只读 | 读远程文本文件 |
| `list_templates` | 只读 | 列出部署模板与参数 |
| `write_file` | 写入 | 创建/覆盖远程文件（自动建父目录） |
| `make_dir` | 写入 | 递归建目录 |
| `move_path` | 写入 | 重命名 / 移动 |
| `delete_path` | 写入 | 删除文件或目录（目录需 recursive） |
| `exec_command` | 写入 | 执行 Shell 命令并返回退出码与输出 |
| `deploy_template` | 写入 | 执行部署模板（真实执行命令） |

Cursor / 其他支持 HTTP 的客户端，把面板里的配置粘到 `mcp.json` 即可：

```json
{
  "mcpServers": {
    "serverpilot": {
      "url": "http://127.0.0.1:8787/mcp",
      "headers": { "Authorization": "Bearer <面板中的令牌>" }
    }
  }
}
```

Claude Desktop 原生只支持 stdio，用 `mcp-remote` 桥接（面板已生成对应片段）：

```json
{
  "mcpServers": {
    "serverpilot": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://127.0.0.1:8787/mcp", "--header", "Authorization: Bearer <令牌>"]
    }
  }
}
```

> 服务随应用启动而启动，关掉 ServerPilot 即停止；端口被占用时会自动向后顺延，面板显示实际端口。

---

## 快捷键

| 组合 | 作用 |
| --- | --- |
| `Ctrl + K` | 打开快速连接面板 |
| `Ctrl + S` | 保存当前编辑的文件 |
| `Esc` | 关闭当前弹层 / 编辑器 / 面板 |

---

## 目录结构

```
ServerPilot/
├─ app/                       应用源码
│  ├─ main.js                 主进程：窗口、IPC、对话框、托盘、单实例、MCP 生命周期
│  ├─ preload.js              安全桥（contextIsolation）
│  ├─ src/
│  │  ├─ store.js             主机配置、收藏夹与凭据加密存储
│  │  ├─ connection-manager.js SSH / SFTP / 传输
│  │  ├─ deployer.js          部署步骤执行器
│  │  ├─ templates.js         部署模板定义
│  │  ├─ mcp-server.js        MCP 协议实现（Streamable HTTP）
│  │  └─ mcp-tools.js         MCP 工具集（12 个）
│  ├─ renderer/               界面（HTML / CSS / JS）
│  ├─ build/                  图标资源
│  └─ tools/                  本地 mock SSH 服务（仅开发测试）
├─ .gitignore                 排除 node_modules / dist / 本地凭据
├─ .gitattributes             统一行尾为 LF，图标按二进制处理
└─ README.md
```

> 打包产物不在版本库内：`npm run dist` 在本地生成 `dist\ServerPilot-1.0.0-portable.exe`。

---

## 开发者

```powershell
cd app
npm install
npm start            # 开发调试
npm run dist         # 打包便携版 exe
```

本地自测（无需真实服务器）：

```powershell
cd app
node tools/mock-ssh-server.js     # 127.0.0.1:2222 / test / test
# SFTP 根目录映射到 tools/mockroot
```

排障说明：

- 连接失败优先看提示文案：`All configured authentication methods failed` 多为密码/私钥不匹配；`Timed out` 多为端口或安全组未放通。
- 老系统出现 `no matching key exchange algorithm` 时，本软件已放宽算法，若仍失败需在服务器升级 `sshd` 或显式开启兼容算法。
- 编辑大文件（>8 MB）会提示改用下载，避免 SFTP 读写阻塞。

---

## 说明

- 仅支持 SSH（Linux / Unix 服务器）；Windows 服务器需开启 OpenSSH Server。
- 所有操作都在本机发起，不经过任何中转服务器。
- 部署模板中的命令会真实执行，请先在测试机验证再用于生产。
