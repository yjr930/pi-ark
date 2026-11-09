# Pi-Ark

Pi-Ark 是一个以 Workspace 为边界管理 pi coding agent 的 Web UI。它通过常驻 HTTPS 服务提供 Agent conversation、Session 管理、文件与 Markdown 阅读、浏览器 Terminal，以及 Global/Workspace Settings。

## 核心能力

- 使用 `@earendil-works/pi-coding-agent` SDK 管理持久化 Session、流式消息、tool activity、queue、Fork 和 Rollback。
- 管理多个服务器 Workspace，并将 Session、metadata 和附件保存在 Workspace 的 `.pi-ark` 目录中。
- 提供 Files 文本、Markdown 与图片预览、可配置的预览上限，以及所有文件的原始下载。
- 通过 xterm.js 和 node-pty 提供以 Workspace 为 cwd 的浏览器 Terminal。
- 提供 Global provider/model defaults、model-specific thinking、subscription OAuth、Pi-Ark release update/rollback、system prompt preview 和 Workspace tools。
- 提供桌面可调整侧栏、移动端 drawer、五种 theme、Session group、permalink 和内部链接。
- 使用 HTTPS、scrypt password、Secure cookie 和服务端 Workspace path guard。

## 环境要求

- Node.js 22.19 或更新版本。
- npm。
- OpenSSL。
- node-pty 所需的本机构建环境。
- 服务账号可以访问的 Workspace 目录。
- 可用的 provider API key 或 subscription account。

## 快速开始

从 GitHub Releases 下载与服务器 architecture 对应的 artifact，然后执行：

```bash
tar -xzf pi-ark-<version>-linux-<architecture>.tar.gz
cd pi-ark-<version>-linux-<architecture>
sudo node scripts/install-release.mjs --no-start
sudo -u pi-ark env PI_ARK_HOME=/var/lib/pi-ark /opt/pi-ark/current/scripts/pi-ark.mjs setup \
  --username ark \
  --password 'choose-a-password' \
  --workspace /absolute/path/to/workspace
sudo systemctl enable --now pi-ark.service
```

Installer 默认使用不可变的 `/opt/pi-ark/releases/<version>`、`/opt/pi-ark/current`、`/var/lib/pi-ark` 和专用的 `pi-ark` service account。现有安装可以通过 `--migrate-data <path>` 迁移 Global data。

Setup 创建 Global config 和自签名 TLS certificate，并默认在 `https://127.0.0.1:31415` 提供服务。`PI_ARK_AGENT_DIR` 可以单独修改 Pi-Ark 专用的 pi agent data directory；默认位置是 `PI_ARK_HOME/pi-agent`。

同一个 hostname 可以运行多个实例。Installer 的 `--instance`、`--base-path`、`--service-name`、`--cli-name`、`--prefix` 和 `--data-dir` 参数分别隔离 instance identity、public URL、systemd service、CLI command、release 目录和 Global data。Frontend assets、API、WebSocket、Files image 和 download URL 都遵循 `PI_ARK_BASE_PATH`。每个实例使用包含 instance identity 的 auth cookie，并将 cookie Path 限定在对应的 public URL path。

## 开发

```bash
npm install
npm run setup -- --username ark --password 'choose-a-password' --workspace /absolute/path/to/workspace
npm run dev
```

Vite 默认位于 `http://localhost:5173`，并将 API 和 WebSocket 转发到本地 Pi-Ark HTTPS 服务。

日常迭代使用 `<next-version>-dev.<iteration>` 版本，不创建 Git tag 或 GitHub Release。双实例部署中的主力开发版使用 `/opt/pi-ark-dev`、`/var/lib/pi-ark-dev` 和 `pi-ark-dev.service`；备用正式版使用 `/opt/pi-ark-backup`、`/var/lib/pi-ark-backup` 和 `pi-ark-backup.service`。正式 release 仅在明确安排发布时创建。Installer 的 `--deferred-restart <seconds>` 通过 transient systemd timer 安排 service restart，使主力开发版可以从自身 Session 发起部署。

项目命令：

```bash
npm run build
npm run check
npm run check:behavior
npm run check:ui
npm run release:build
npm start
```

## 命令行管理

修改登录密码：

```bash
pi-ark password
```

`pi-ark passwd` 是同一命令的简写。自动化环境可以使用 `PI_ARK_NEW_PASSWORD`，`--no-restart` 可以延后服务重启。

Release 安装还提供以下命令：

```bash
pi-ark update
pi-ark rollback
pi-ark status
pi-ark logs
pi-ark restart
```

双实例部署使用对应的 command name：主力开发版使用 `pi-ark-dev`，备用正式版使用 `pi-ark-backup`。

## 数据位置

```text
PI_ARK_HOME/
  config.json
  tls/
  pi-agent/

<workspace>/.pi-ark/
  config.json
  sessions-meta.json
  attachments/
  sessions/
```

Terminal 和 Agent tools 使用 Pi-Ark 服务进程的系统权限。公开网络中的部署应使用专用系统账号，并限制该账号可以访问的 Workspace。

## 文档

- [文档索引](docs/index.md)
- [功能与交互设计](docs/product-and-interaction.md)
- [程序实现架构](docs/architecture.md)
- [使用手册](docs/user-guide.md)
- [Pi 集成调研](docs/research.md)
