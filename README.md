# Pi-Ark

Pi-Ark 是一个以 Workspace 为边界管理 pi coding agent 的 Web UI。它通过常驻 HTTPS 服务提供 Agent conversation、Session 管理、文件与 Markdown 阅读、浏览器 Terminal，以及 统一的 Global Settings。

## 核心能力

- 使用 `@earendil-works/pi-coding-agent` SDK 管理持久化 Session、流式消息、tool activity、queue、Fork 和 Rollback。
- 使用 IndexedDB 保存最近五个 Session 的 conversation 与 composer 状态，浏览器刷新后继续恢复，并可在 Settings → Interface 清理。
- 管理多个服务器 Workspace，并将 Session、metadata 和附件保存在 Workspace 的 `.pi-ark` 目录中。
- Agent 自带 `read_pi_ark_link`，可以读取内部链接所指向的会话和消息，并按需取得前后文。
- Agent 可以通过 `subagent` 并行委派任务，并继续向已有子 Session 发送后续任务；Web 在状态栏提供 subagent 的数量与列表，以及父子会话导航。
- 提供 Files 文本、Markdown 与图片预览、可配置的预览上限，以及所有文件的原始下载。
- 通过 xterm.js 和 node-pty 提供以 Workspace 为 cwd 的多 Tab Terminal，支持跨平台 shell 配置与中文字体，切换页面时保留终端界面，浏览器刷新后重连 Server 当前运行期间保留的进程和输出。
- 提供 Global provider/model defaults、model-specific thinking、subscription OAuth、Pi-Ark release update/rollback、全局 system prompt 和文件浏览设置。
- 提供桌面可调整侧栏、移动端 drawer、五种 theme、全局 reasoning visibility、Session group、Workspace Notebook、permalink 和内部链接。
- 使用 HTTPS、scrypt password、Secure cookie 和服务端 Workspace path guard。

## 环境要求

- Node.js 22.19 或更新版本，Node architecture 与安装包一致。
- Linux：Bash、tar；默认的系统安装使用 systemd，`--portable` 使用当前用户的后台进程。
- macOS：系统 Bash 与 tar。
- Windows 10/11 x64：Git for Windows 提供的 Git Bash，以及系统内置的 PowerShell。
- 运行 Pi-Ark 的账号可以访问的 Workspace 目录。
- 可用的 provider API key 或 subscription account。

Release 安装包包含 production dependencies 和当前平台的 native node-pty。源码开发还需要 Git、npm、Python 和对应平台的 C++ 编译工具，详见[使用手册](docs/user-guide.md#环境要求)。Setup 使用随安装包提供的 JavaScript 依赖生成 TLS certificate。

## 快速开始

从 GitHub Releases 下载与操作系统及 architecture 对应的安装包：Linux x64/arm64、macOS Intel x64/Apple Silicon arm64 使用 `.tar.gz`，Windows x64 使用 `.zip`。以下示例先安装，再通过稳定 CLI 配置 Workspace 并启动。

### Linux

默认安装使用 systemd：

```bash
VERSION="<version>"
ARCH="x64"
tar -xzf "pi-ark-${VERSION}-linux-${ARCH}.tar.gz"
cd "pi-ark-${VERSION}-linux-${ARCH}"
sudo node scripts/install-release.mjs --no-start
sudo -u pi-ark node /opt/pi-ark/bin/pi-ark.mjs setup --username ark --password "choose-a-password" --workspace "/absolute/path/to/workspace"
sudo systemctl enable --now pi-ark.service
```

Installer 默认使用 `/opt/pi-ark/releases/<version>`、`/opt/pi-ark/current`、`/var/lib/pi-ark` 和专用的 `pi-ark` service account。现有安装可以通过 `--migrate-data <path>` 迁移 Global data。当前用户安装可使用 `node scripts/install-release.mjs --portable --no-start`，稳定 CLI 位于 `~/.local/share/pi-ark/bin/pi-ark.mjs`。

### macOS

在 shell 中执行（Apple Silicon 使用 `arm64`，Intel 使用 `x64`）：

```bash
VERSION="<version>"
ARCH="arm64"
tar -xzf "pi-ark-${VERSION}-darwin-${ARCH}.tar.gz"
node "pi-ark-${VERSION}-darwin-${ARCH}/scripts/install-release.mjs" --no-start
node "$HOME/Library/Application Support/Pi-Ark/app/bin/pi-ark.mjs" setup --username ark --password "choose-a-password" --workspace "$HOME/path/to/workspace"
node "$HOME/Library/Application Support/Pi-Ark/app/bin/pi-ark.mjs" start
```

### Windows

在 PowerShell 中执行：

```powershell
$Version = "<version>"
Expand-Archive -LiteralPath "pi-ark-$Version-win32-x64.zip" -DestinationPath "." -Force
node ".\pi-ark-$Version-win32-x64\scripts\install-release.mjs" --no-start
node "$env:LOCALAPPDATA\Pi-Ark\app\bin\pi-ark.mjs" setup --username ark --password "choose-a-password" --workspace "$HOME\path\to\workspace"
node "$env:LOCALAPPDATA\Pi-Ark\app\bin\pi-ark.mjs" start
```

macOS 与 Windows 默认使用当前用户的 portable 安装；后台进程在关闭启动终端后继续运行。稳定入口位于 `<prefix>/bin/pi-ark.mjs`，同目录还提供 POSIX launcher 与 Windows `.cmd`，可以使用完整路径或自行将该目录加入 PATH。各平台的默认 data directory 与完整操作见[使用手册](docs/user-guide.md#安装与初始化)。

Setup 创建 Global config 和自签名 TLS certificate，并默认在 `https://127.0.0.1:31415` 提供服务。`PI_ARK_AGENT_DIR` 可以单独修改 Pi-Ark 专用的 pi agent data directory；默认位置是 `PI_ARK_HOME/pi-agent`。

同一个 hostname 可以运行多个实例。Installer 的 `--instance`、`--base-path`、`--service-name`、`--cli-name`、`--prefix` 和 `--data-dir` 参数分别隔离 instance identity、public URL、systemd service、CLI command、release 目录和 Global data。Frontend assets、API、WebSocket、Files image 和 download URL 都遵循 `PI_ARK_BASE_PATH`。每个实例使用包含 instance identity 的 auth cookie，并将 cookie Path 限定在对应的 public URL path。

## 开发

```bash
npm install
npm run setup -- --username ark --password "choose-a-password" --workspace "."
npm run dev
```

Vite 默认位于 `http://localhost:5173`，并将 API 和 WebSocket 转发到本地 Pi-Ark HTTPS 服务。

日常迭代使用 `<next-version>-dev.<iteration>` 版本，不创建 Git tag 或 GitHub Release。双实例部署中的主力开发版使用 `/opt/pi-ark-dev`、`/var/lib/pi-ark-dev` 和 `pi-ark-dev.service`；备用正式版使用 `/opt/pi-ark-backup`、`/var/lib/pi-ark-backup` 和 `pi-ark-backup.service`。正式 release 仅在明确安排发布时创建。主力开发版从自身 Session 发起部署时，先在独立配置与数据目录中确认安装包的启动、health 与版本，再由安装器验证候选 systemd unit 和加载状态，最后使用 `--deferred-restart <seconds>` 登记 transient systemd timer。当前 Agent 在重启前返回检查结果与重启安排，随后结束本轮操作。完整步骤见[使用手册](docs/user-guide.md#开发模式)。

项目命令：

```bash
npm run build
npm run check
npm run check:behavior
npm run check:setup
npm run check:platform
npm run check:release-process
npm run check:release -- "path/to/extracted-artifact"
npm run check:subagents
npm run check:subagents-ui
npm run check:ui
npm run check:terminal
npm run check:terminal-appearance
npm run check:terminal-ui
npm run release:build
npm start
```

`check:terminal` 使用临时配置与实际 PTY 检查配置、shell 选择和 Tab 生命周期，并包含在 `check:behavior` 中。`check:terminal-appearance` 检查系统等宽字体的默认值与历史字体偏好的迁移。`check:terminal-ui` 使用 `PI_ARK_CHECK_URL` 与 `PI_ARK_CHECK_WORKSPACE` 指定的独立实例和工作目录检查浏览器交互。

## 正式发布

在 source checkout 中，从已经确认的 dev 实例准备正式版本：

```bash
VERSION="0.1.6"
npm run release:prepare -- --version "$VERSION"
npm run release:status -- --version "$VERSION" --watch
npm run release:publish -- --version "$VERSION" --watch
```

`prepare` 从 Linux dev 服务的实际进程与安装包来源记录固定源码，在 `.tmp/release-process/<version>/` 中创建隔离工作区并推送候选分支。`status` 显示原生构建进度与具体错误；`publish` 创建正式 tag，并让 GitHub Release 复用已确认的候选安装包。发布前修正源码时，使用 `prepare --source <已确认的 Git ref> --refresh` 更新同一目标版本的候选。

其他来源使用 `--source <已确认的 Git ref>`。来源记录、恢复步骤和发布后的实例更新见[使用手册](docs/user-guide.md#从-dev-实例到正式发布上线)。

## 命令行管理

修改登录密码：

```text
node "<prefix>/bin/pi-ark.mjs" password
```

`passwd` 是同一命令的简写。自动化环境可以使用 `PI_ARK_NEW_PASSWORD`，`--no-restart` 可以延后服务重启。

Release 安装提供以下命令；下例中的 `node "<prefix>/bin/pi-ark.mjs"` 使用安装器输出的稳定入口：

```text
node "<prefix>/bin/pi-ark.mjs" start
node "<prefix>/bin/pi-ark.mjs" stop
node "<prefix>/bin/pi-ark.mjs" restart
node "<prefix>/bin/pi-ark.mjs" status
node "<prefix>/bin/pi-ark.mjs" logs
node "<prefix>/bin/pi-ark.mjs" update
node "<prefix>/bin/pi-ark.mjs" rollback
```

`serve` 在前台运行；portable 的 `start` 在后台运行，`logs --follow` 持续显示新日志。Linux 的系统安装同时提供 `/usr/local/bin/pi-ark`。

双实例部署使用对应的 command name：主力开发版使用 `pi-ark-dev`，备用正式版使用 `pi-ark-backup`；稳定入口的文件名相应为 `pi-ark-dev.mjs` 与 `pi-ark-backup.mjs`。

Release workflow 在 `main` 或 `release/**` 分支 push 时，为上述平台构建原生安装包并执行安装 smoke，也支持 `workflow_dispatch`。正式 tag 使用同一候选 commit 的安装包发布 GitHub Release。

## 数据位置

```text
PI_ARK_HOME/
  config.json
  tls/
  pi-agent/

<workspace>/.pi-ark/
  notebook.md
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
