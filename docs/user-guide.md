# Pi-Ark 使用手册

## 环境要求

所有平台使用 Node.js 22.19 或更新版本，Node architecture 需要与安装包一致。

| 平台 | Release 安装的运行前置 |
|---|---|
| Linux x64/arm64 | Bash、tar；默认系统安装还需要 systemd |
| macOS Intel x64/Apple Silicon arm64 | 系统 Bash 与 tar |
| Windows 10/11 x64 | Git for Windows 提供的 Git Bash，以及系统内置的 PowerShell |

Linux 的 `--portable` 安装使用当前用户的后台进程。Windows 的 Agent 的 `bash` 工具使用 Git Bash，浏览器 Terminal 默认使用 PowerShell；macOS 与 Linux 的 Terminal 使用 `SHELL` 指定的 shell，或 `/bin/bash`。

Release 安装包包含 production dependencies 与当前平台的 native node-pty。Setup 使用安装包中的 JavaScript 依赖生成 TLS certificate。运行账号需要能够访问所注册的 Workspace，并需要可用的 provider API key 或 subscription account。

源码开发还需要 Git、npm、Python 与 C++ 编译工具：Linux 使用 make 与 GCC/G++，macOS 使用 Xcode Command Line Tools，Windows 使用 Visual Studio 2022 Build Tools 的 C++ workload 与对应的 Spectre-mitigated runtime libraries。这些工具用于编译 node-pty 等 native dependencies。

## 安装与初始化

从 GitHub Releases 下载与本机对应的 artifact：

| 操作系统与 architecture | 安装包名称 |
|---|---|
| Linux x64 | `pi-ark-<version>-linux-x64.tar.gz` |
| Linux arm64 | `pi-ark-<version>-linux-arm64.tar.gz` |
| macOS Intel x64 | `pi-ark-<version>-darwin-x64.tar.gz` |
| macOS Apple Silicon arm64 | `pi-ark-<version>-darwin-arm64.tar.gz` |
| Windows x64 | `pi-ark-<version>-win32-x64.zip` |

### Linux 系统安装

默认安装使用专用 service account 与 systemd：

```bash
VERSION="<version>"
ARCH="x64"
tar -xzf "pi-ark-${VERSION}-linux-${ARCH}.tar.gz"
cd "pi-ark-${VERSION}-linux-${ARCH}"
sudo node scripts/install-release.mjs --no-start
sudo -u pi-ark node /opt/pi-ark/bin/pi-ark.mjs setup --username ark --password "choose-a-password" --workspace "/absolute/path/to/workspace"
sudo systemctl enable --now pi-ark.service
```

Installer 创建以下运行结构：

```text
/opt/pi-ark/current -> /opt/pi-ark/releases/<version>
/var/lib/pi-ark/
/etc/systemd/system/pi-ark.service
/usr/local/bin/pi-ark
```

稳定 CLI 位于 `/opt/pi-ark/bin/pi-ark.mjs`，`/usr/local/bin/pi-ark` 使用该入口。现有安装可以通过 `sudo node scripts/install-release.mjs --migrate-data /path/to/existing-data` 复制 Global config、TLS 和 pi agent data。Installer 默认创建专用的 `pi-ark` service account；所有已注册的 Workspace 都需要允许该账号访问。

### macOS 当前用户安装

在下载目录的 shell 中执行，将 `<version>` 替换为下载的版本。Apple Silicon 使用 `arm64`，Intel 使用 `x64`：

```bash
VERSION="<version>"
ARCH="arm64"
tar -xzf "pi-ark-${VERSION}-darwin-${ARCH}.tar.gz"
node "pi-ark-${VERSION}-darwin-${ARCH}/scripts/install-release.mjs" --no-start
node "$HOME/Library/Application Support/Pi-Ark/app/bin/pi-ark.mjs" setup --username ark --password "choose-a-password" --workspace "$HOME/path/to/workspace"
node "$HOME/Library/Application Support/Pi-Ark/app/bin/pi-ark.mjs" start
```

### Windows 当前用户安装

在下载目录的 PowerShell 中执行，将 `<version>` 替换为下载的版本：

```powershell
$Version = "<version>"
Expand-Archive -LiteralPath "pi-ark-$Version-win32-x64.zip" -DestinationPath "." -Force
node ".\pi-ark-$Version-win32-x64\scripts\install-release.mjs" --no-start
node "$env:LOCALAPPDATA\Pi-Ark\app\bin\pi-ark.mjs" setup --username ark --password "choose-a-password" --workspace "$HOME\path\to\workspace"
node "$env:LOCALAPPDATA\Pi-Ark\app\bin\pi-ark.mjs" start
```

### Portable 布局与稳定入口

macOS 和 Windows 默认使用当前用户的 portable 安装；Linux 可以在解压目录执行以下命令：

```bash
node scripts/install-release.mjs --portable --no-start
node "$HOME/.local/share/pi-ark/bin/pi-ark.mjs" setup --username ark --password "choose-a-password" --workspace "$HOME/path/to/workspace"
node "$HOME/.local/share/pi-ark/bin/pi-ark.mjs" start
```

| 平台与安装模式 | 默认 prefix | 默认 Global data directory |
|---|---|---|
| Linux systemd | `/opt/pi-ark` | `/var/lib/pi-ark` |
| Linux portable | `~/.local/share/pi-ark` | `~/.pi-ark` |
| macOS portable | `~/Library/Application Support/Pi-Ark/app` | `~/Library/Application Support/Pi-Ark/data` |
| Windows portable | `%LOCALAPPDATA%\Pi-Ark\app` | `%LOCALAPPDATA%\Pi-Ark\data` |

安装器输出稳定 CLI 的完整 Node 调用命令。稳定入口位于 `<prefix>/bin/pi-ark.mjs`，同目录提供 POSIX launcher `pi-ark` 与 Windows `pi-ark.cmd`。可以使用完整路径，也可以自行将该 `bin` 目录加入 PATH。Portable 的 `start` 在后台启动，关闭启动终端后服务继续运行；`serve` 用于前台运行。

首次安装使用 `--no-start`，随后执行 `setup` 配置登录信息与 Workspace，最后执行 `start`。Data directory 独立于 release directory，更新和回退会保留配置与 Workspace 数据。

### 多实例与安装参数

同一个 hostname 的 Linux 系统安装可以使用以下独立布局：

```text
/opt/pi-ark-dev/       /var/lib/pi-ark-dev/       pi-ark-dev.service       /usr/local/bin/pi-ark-dev
/opt/pi-ark-backup/    /var/lib/pi-ark-backup/    pi-ark-backup.service    /usr/local/bin/pi-ark-backup
```

Installer 使用以下参数创建实例：

| 参数 | 作用 |
|---|---|
| `--instance <name>` | 设置 instance identity，并生成默认 service 与 CLI 名称 |
| `--base-path <path>` | 设置 public URL path，例如 `/pi-ark` |
| `--service-name <name>` | 设置 systemd service unit |
| `--cli-name <name>` | 设置稳定 CLI 的文件名；Linux 系统安装同时创建 `/usr/local/bin` command |
| `--prefix <path>` | 设置 release installation prefix |
| `--data-dir <path>` | 设置独立的 Global data directory |
| `--port <number>` | 修改已有或迁移后的 Global config 中的 listen port |
| `--deferred-restart <seconds>` | 在 Linux 系统安装中使用 transient systemd timer 延后重启当前实例 |
| `--portable` | 在 Linux 中选择当前用户安装；macOS 与 Windows 默认使用该模式 |
| `--no-start` | 完成安装后保留服务的当前运行状态，供首次 setup 或另行安排启动 |
| `--migrate-data <path>` | 从已有目录复制 Global data，并更新对应的 TLS 路径 |

非 default instance 的默认目录名称添加 `-<instance>` 后缀，例如 macOS 的 `Pi-Ark-dev/app` 与 Windows 的 `Pi-Ark-dev\app`；Linux 的目录相应为 `/opt/pi-ark-dev` 或 `~/.local/share/pi-ark-dev`。稳定 CLI 的文件名相应为 `pi-ark-dev.mjs`。

Fresh installation 在 `setup --port <number>` 中设置 listen port；installer 的 `--port` 更新已有配置，并将端口保存为后续 setup 的默认值。`PI_ARK_BASE_PATH` 不包含末尾的 `/`。Browser URL 使用包含末尾 `/` 的路径，例如 `/pi-ark/`。实例分别保存 Global settings、provider credentials、pi agent data 和 auth sessions。Workspace 中的 `.pi-ark` 目录可以由两个实例共享；同一个 Session 在同一时刻由一个实例操作。

初始化命令支持以下参数：

| 参数 | 作用 | 默认值 |
|---|---|---|
| `--username` | 登录用户名，也可使用 `PI_ARK_USERNAME` | 必填 |
| `--password` | 登录密码，也可使用 `PI_ARK_PASSWORD` | 必填 |
| `--workspace` | 初始 Workspace 的绝对路径 | 当前目录 |
| `--id` | 初始 Workspace ID | 目录名称 |
| `--name` | 初始 Workspace 显示名称 | Workspace ID |
| `--host` | HTTPS 监听地址 | `127.0.0.1` |
| `--port` | HTTPS 监听端口 | `31415` |

稳定 CLI 自动读取安装时保存的 data directory 与实例环境。源码命令可以使用 `PI_ARK_HOME` 修改 data directory，源码的默认位置是 `~/.pi-ark`。`PI_ARK_AGENT_DIR` 可以修改 Pi-Ark 专用的 pi agent data directory，默认位置是 `PI_ARK_HOME/pi-agent`。

自动化可以通过 `PI_ARK_USERNAME` 与 `PI_ARK_PASSWORD` 提供 setup 的登录信息。POSIX shell 使用 `export PI_ARK_PASSWORD="choose-a-password"`，PowerShell 使用 `$env:PI_ARK_PASSWORD = "choose-a-password"`，然后执行相同的 setup 命令并省略 `--password`。

Setup 生成 RSA 3072-bit 的自签名 certificate，有效期为 825 天，SAN 包含 `localhost` 与 `127.0.0.1`。初始化命令会输出 HTTPS 地址，并提示在启动 Pi-Ark 后访问该地址。使用自签名证书时，首次访问需要在浏览器中确认该证书。

## 开发模式

从 source checkout 开发时运行：

```bash
npm install
npm run setup -- --username ark --password "choose-a-password" --workspace "."
npm run dev
```

Vite 默认使用 `http://localhost:5173`，并将 API 和 WebSocket 请求转发给本地 Pi-Ark HTTPS 服务。

日常迭代使用 `<next-version>-dev.<iteration>` 版本。双实例部署中的主力开发版从 `/opt/pi-ark-dev/releases/<dev-version>` 运行；备用正式版从 `/opt/pi-ark-backup/releases/<release-version>` 运行。日常流程不创建 Git tag 或 GitHub Release。正式 release 仅在明确安排发布时创建。主力开发版从自身 Session 发起安装时，按以下顺序完成自替换：

1. 构建已提交源码的安装包，执行安装包的 `verify --release`，并使用独立的配置与数据目录确认安装包可以启动、`/api/health` 正常且实际运行版本符合预期。源码工作区提供 `npm run check:release -- "path/to/extracted-artifact"` 完成独立的安装与启动检查。
2. 确认目标实例的 prefix、data directory、service account、listen 配置和恢复版本，沿用现有实例参数调用安装器。
3. 安装器在切换版本与写入真实 service unit 前，使用 `systemd-analyze verify` 验证候选 unit；写入后执行 `daemon-reload`，确认 `LoadState=loaded`。
4. 使用安装器的 `--deferred-restart <seconds>` 登记 transient systemd timer。安装器返回后，确认目标版本路径、保留的配置与 timer 的登记结果，向用户报告检查结果及重启安排。
5. 当前 Agent 在重启前返回结果并结束本轮操作，随后由 systemd 重启服务。用户或后续独立 Session 可以查看重启后的运行状态。

Nginx 在同一个 server block 中先配置具体的 instance path，再保留其他应用的 location。Pi-Ark upstream 使用 HTTPS，并转发 WebSocket headers：

```nginx
location = /pi-ark { return 301 /pi-ark/; }
location ^~ /pi-ark/ {
  proxy_pass https://127.0.0.1:14116/;
  proxy_ssl_verify off;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection $pi_web_connection_upgrade;
  proxy_read_timeout 3600s;
  proxy_buffering off;
}

location = /pi-ark-backup { return 301 /pi-ark-backup/; }
location ^~ /pi-ark-backup/ {
  proxy_pass https://127.0.0.1:14117/;
  proxy_ssl_verify off;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection $pi_web_connection_upgrade;
  proxy_read_timeout 3600s;
  proxy_buffering off;
}
```

备用实例用于主力开发版的恢复与高风险部署。主力开发版无法访问时，从 `/pi-ark-backup/` 打开对应的 Workspace，并在新的 Session 中修复 source checkout 或重新安装主力开发版。

常用项目命令：

```bash
npm run build
npm run check
npm run check:behavior
npm run check:setup
npm run check:platform
npm run check:release-process
npm run check:release -- "path/to/extracted-artifact"
npm run check:ui
npm run release:build
npm start
```

## 登录与退出

登录页使用初始化时配置的用户名和密码。登录成功后，浏览器获得 Secure、HttpOnly 和 SameSite=Strict cookie。

退出入口位于 Settings → Global → Account。退出后，当前浏览器 cookie 失效并返回登录页。

## 修改登录密码

交互式修改密码：

```text
node "<prefix>/bin/pi-ark.mjs" password
```

`passwd` 是相同命令的简写。该 command 更新安装实例的 `config.json` 并重启对应的后台进程或 systemd service。Linux 双实例部署也可以使用 `pi-ark-dev password` 与 `pi-ark-backup password`。

指定配置文件或延后重启：

```text
node "<prefix>/bin/pi-ark.mjs" password --config "path/to/config.json" --no-restart
```

自动化环境可以通过 `PI_ARK_NEW_PASSWORD` 提供新密码。POSIX shell 示例：

```bash
export PI_ARK_NEW_PASSWORD="new-password"
node "$HOME/Library/Application Support/Pi-Ark/app/bin/pi-ark.mjs" password --no-restart
```

Windows PowerShell 示例：

```powershell
$env:PI_ARK_NEW_PASSWORD = "new-password"
node "$env:LOCALAPPDATA\Pi-Ark\app\bin\pi-ark.mjs" password --no-restart
```

新密码至少包含 6 个字符。使用 `--no-restart` 后，需要在后续维护窗口重启服务，使内存中的认证服务读取新摘要。

## Workspace 操作

### 添加 Workspace

1. 点击侧栏 Workspaces 旁的加号。
2. 输入服务器上的绝对目录，或从目录建议中选择。
3. 输入显示名称。
4. 确认添加。

目录必须已经存在，并且 Pi-Ark 服务账号可以访问。添加后，Pi-Ark 会创建 `.pi-ark` 状态目录。

### 切换 Workspace

点击侧栏中的 Workspace。Agent、Files 和 Terminal 会切换到该目录；Settings 使用统一的全局配置。

### 重命名 Workspace

打开 Workspace 行的操作菜单并选择 Rename。此操作只修改显示名称。

### 关闭与重新打开 Workspace

选择 Close 并确认后，Workspace 从侧栏和 Global registry 中移除。服务器目录、项目文件、附件和 Session 保持原状。Pi-Ark 同时关闭该 Workspace 的所有 Terminal Tab，并释放对应的进程和输出。

再次通过 Add workspace 添加相同目录后，原有 Session 和 settings 会重新出现。

## Session 操作

### 新建 Session

Sessions 标题右侧的四个按钮从左到右依次是显示归档 Session、打开内部链接、新增 Session group 和新建 Session。点击最右侧的加号后，新 Session 会立即打开。发送首条 message 后，侧栏列表立即出现这一行，并使用该条 user message 作为默认标题。

### 管理 Session

打开 Session 行的操作菜单可以执行以下操作：

- Rename：设置便于查找的标题。
- Copy session link：复制 Pi-Ark 内部链接。
- Manage groups：选择一个或多个 Session group。
- Pin 或 Unpin：调整活跃 Session 的置顶状态。
- Archive 或 Restore：移动到 Archived 区域或恢复。
- Delete：删除 conversation file、metadata 和 Session 附件。

Delete 会影响 Session 数据。确认对话框会显示即将删除的 Session 名称。

每个 Session row 使用单行布局，较长标题会省略。列表不直接显示更新时间；将鼠标停在 Session row 上时，浏览器 tooltip 按 `Last Updated: xxxx-xx-xx xx:xx:xx` 显示最近更新时间。

Session row 会显示当前状态：旋转图标表示 Agent 正在运行；绿色圆点表示该 Session 处于 Ready 且有尚未查看的新输出；感叹号表示最近一次 Agent run 发生错误。Running 和 Error 期间暂时隐藏绿色圆点，未查看的输出记录继续保留，回到 Ready 后恢复对应的提示。在可见的 Agent 页面查看该 Session 后，浏览器确认当时的更新序号，圆点随之消失。较旧的状态响应会保留已经确认的查看进度。这份查看记录保存在当前浏览器页面的内存中，切换 Workspace 后返回仍然保留，刷新页面后重新加载。Error 图标会保留到下一次运行更新状态。Question 状态显示属于后续计划，当前 Agent runtime 尚未提供显式 question state。

### 使用 Session group

点击 Sessions 标题栏的 New session group 图标创建 group。每个 group 可以重命名或删除。Manage groups 允许同一个 Session 同时加入多个 group。

### 使用 Notebook

点击 Session 列表顶部的 Notebook 行，主内容区会打开当前 Workspace 的临时笔记。直接输入文字即可；停止输入约 300 ms 后页面自动保存，离开输入框或切换页面时也会提交尚未保存的内容。右上角显示 Loading notes、Saving、Saved 或 Save failed。笔记保存在 `<workspace>/.pi-ark/notebook.md`，每个 Workspace 使用独立内容。

### 打开内部链接

点击 Sessions 标题旁的链接按钮，粘贴以下形式的链接：

```text
pi-ark://workspace/<workspace-id>/session/<session-id>
pi-ark://workspace/<workspace-id>/session/<session-id>/message/<message-id>
```

目标 Workspace 必须已经在当前服务中打开。Message ID 使用 `m` 加六位小写 base36，例如 `m04k9z2`。Message link 会定位并高亮对应 message；旧的纯数字 message target 继续兼容。

## 使用 Agent

### 等待 Session 加载

首次打开 Session 时，页面先显示 Loading conversation。首个 snapshot 到达后，composer 和 conversation controls 才会出现。较长 Session 的加载进度采用持续移动的进度条。浏览器在内存中保存最近五个 Session 的 snapshot 和 UI state；切回这些 Session 时会立即显示已有 conversation，并以 Refreshing conversation 状态在后台取得 Server snapshot。UI state 会恢复 composer 中尚未发送的 text、attachments，以及 Running、Tool、Reasoning、Compact 和 Message Info 的展开状态。浏览器刷新会清空该内存 cache。

长会话的初始 Server snapshot 默认只包含最新约 100 条 messages。点击顶部 Show earlier messages 会向 Server 请求 earlier messages，并逐页扩展当前 display window，直至看到完整活动 branch。

### 发送 message

Composer 为空时显示 `Send message here`。在 composer 中输入内容并按 Enter。使用 Shift+Enter 添加换行。输入法候选状态中的 Enter 交给输入法处理。发送后，user message 会立即显示在 conversation 中。

输入框最多展开到十行，之后在输入框内部滚动。Composer 在 Compact、Wide 和 Full 模式下保持相同宽度；这些模式调整 conversation message 区域。Conversation 在页面位于底部附近时跟随新输出；向上滚动后，页面保留当前阅读位置。当前 turn 的 user message 越过顶部后会固定显示在 conversation 顶部；向上滚动到原 message 时，顶部 bar 会立即切换到前一个 user message。点击顶部 User bar 的任意位置可以返回原 message；定位后的 User message 位于顶部 bar 下方，并保留 8 px 间距。

### 选择当前 Session 的 model

Composer 底部提供 model 与 thinking 选择器，选择器直接显示当前值。Model 选项来自 Settings → Global → Provider and model 中已经勾选且当前具有可用认证的模型；Thinking 选项来自 pi 为当前模型声明的 capability。

这里的选择只更新当前 Session。新 Session 使用 Settings → Global → Provider and model 中带星标的 default model。

### 添加附件

点击回形针按钮选择文件，或将剪贴板图片粘贴到 composer。

限制如下：

- 每条 message 最多 8 个附件。
- 单个附件最大 10 MB。
- 所有附件总大小最大 20 MB。
- 图片预览支持 PNG、JPEG、GIF 和 WebP。

发送前可以从附件队列中删除文件。附件发送后保存在 `<workspace>/.pi-ark/attachments/<session>/`，prompt 会包含对应服务器路径。

### 查看工具过程

父子 Session 新建和重新打开时统一启用文件工具（`read`、`bash`、`edit` 和 `write`）。

每条 User message 在 turn 起点显示为全宽色带，其中包含用户头像、`User` 标签、短 Message ID、内部链接和可用的 Rollback。色带使用与 conversation 底色有区分的背景，只有上、下 separator，没有左右边框、圆角或阴影，并延伸到 conversation 内容列的左右边界。Separator 与上下内容之间保留更大的间距。色带内部的左侧和上侧留白略大于右侧和下侧。每个 theme 都使用与自身背景协调的 User 颜色，并与 AI 颜色保持区分；User 与 AI 的头像和名称都使用更大的尺寸。每轮 AI response 只在开头显示一次 AI 头像和 `AI` 标签。角色头像只占用 header 行，后续内容继续使用 conversation 的完整宽度。普通文字、图片、reasoning、tool 与 Compact 内容按原始顺序组成连续 feed，不再为每条 assistant message 显示独立卡片。Reasoning 使用较小字号和与普通 text 一致的行高。

AI 运行期间，commentary、tool call 和 tool result 显示在带 Running 状态的 run collapse 中。没有已保存状态时，Running 默认展开，其中正在执行和已经完成的 tool items 都默认关闭；用户可以手动展开 tool item。AI 完成后，该 run collapse 自动折叠，summary 显示用时和工具消息数量，最后一条非工具内容保持展开。展开 run 后，用时 summary 会以不透明背景固定显示在顶部 User bar 下方。切换 Session 后再返回时，页面恢复用户后来手动调整的 Running、Tool、Reasoning、Compact 和 Message Info 状态。

每个 tool call 与 result 合并为一行工具项。工具 logo 位于折叠框内，后面显示工具名称、command/path/arguments 摘要和 Running、Completed、Failed 或 Result 状态。Running、Failed、Result 和 Saved 分别使用不同的 theme color，Completed 使用中性色。Running 与其他状态使用相同的单层 row 结构；Tool permalink 通过 row 内侧的 accent 标识 target。大 Run group 与内部 Tool row 使用不同的 theme surface：Run group 使用 theme tint，Tool row 和 Reasoning 使用更亮、更中性的颜色。Paper theme 中，Run group 使用低饱和 sage-gray tint，Tool row 使用浅白色；其他 themes 保持相同的外层与内层层级。连续工具项使用紧凑间距。展开内容与折叠框左边界对齐；第一行显示 Call 与 Result 的消息 link 按钮，点击整段文字或图标都可以复制对应的 `pi-ark://` link；tooltip 在页面浮层中显示。页面中的短 Message ID 统一使用斜体。Arguments 按字段显示，每个 key 使用 heading 样式，下一行显示 value，嵌套 object/array 使用缩进文本，空 arguments 显示 `No arguments`；Result 显示文字或图片结果。展开内容的底部左侧显示最后的时间，已有结果时采用对应的结果时间，等待结果期间采用调用时间；时间格式为 `YYYY-MM-DD HH:mm:ss`，使用浏览器所在的时区。

Text item 直接显示普通文字、图片和 reasoning。含普通 text 或 image 的已完成 assistant item 在内容末尾默认显示 Copy Markdown、Fork session 和 Info；对应的流式 item 显示 Info。操作行的左侧显示消息时间，格式为 `YYYY-MM-DD HH:mm:ss`，使用浏览器所在的时区；操作按钮保留在右侧。只包含 reasoning 和 toolCall 的 message 不显示这些操作。点击 Info 后，信息栏显示 model、context、input/output token、source Message ID 与 `pi-ark://` link；流式输出期间的信息栏只显示当前可用的信息。User header 提供内部链接与 Rollback。

Agent settled 后，如果历史 turn 缺少最后一条非工具内容，页面会显示紧凑的单行 Response interrupted warning。对应工具活动仍然可以通过折叠框查看。

连续的工具调用按可见内容分组，默认显示最后 3 个调用，点击 `show more tool call` 可显示较早的调用，点击 `show less tool call` 可恢复折叠。一个 message 中的多个调用分别计数。开启 Hide reasoning 后，隐藏的 thinking block（包括只包含 thinking 的独立 message）前后的连续调用归入同一分组。可见的 Reasoning、普通正文、图片、Compact、branch summary 和独立结果继续中断分组，包含普通正文或图片的 message 按原样显示。分组保留原始消息及其 permalink，并随 Session UI cache 恢复展开状态；较早调用的 permalink 会在首次访问时展开对应分组。

`subagent` 的工具行使用普通工具行 3 倍的收起高度，并独立于连续 tool call 的折叠分组显示。

Compact 的收起高度为普通工具行的 3 倍，并显示压缩耗时、压缩前后的 token 用量，以及 System prompt、Summary 和 Retained 的 token 用量。`≈` 表示 pi SDK 的估算值。展开后可以查看触发原因、生成摘要的 token 用量、source Message ID、内部链接和 compact summary。后续压缩会记录实际耗时；历史字段按已有记录展示。compact 前的原始 messages 继续保留在会话中，并通过 Show earlier messages 逐页显示。

### Queue

AI 正在工作时，Send 标记为 Send follow-up，新 message 默认进入 Follow-up Queue。点击 Send follow-up 后，Queue 立即显示该 message 和 Scheduling；Server 通过轻量 Queue state 确认 item 后，Scheduling row 自动替换为正式 row。提交或连接失败时，该 row 显示 Failed，并提供清除按钮。每个正式 queued message 标记为 Steering 或 Follow-up。Queue mutation 使用 operation ID 和 revision 协调 optimistic UI 与 pi 的权威 Queue；快速连续操作共用当前 rebuild，并在目标 Queue 变化时追加一次 rebuild pass。Queue 使用紧凑的 message rows 和独立的滚动区域；Queue 增高时 conversation 自动使用剩余高度。

- Edit 将 queued message 从 Queue 取回 composer。Composer 已有文字或 attachments 时，确认 Replace draft 才会覆盖；Cancel 会保留原 composer content 与 Queue item。确认后 row 立即移除，Server response 到达后 queued text 进入 composer。
- Merge follow-ups 立即按照当前顺序显示合并后的 Follow-up；Server 使用空行拼接全部 Follow-up，并保留 attachments 与 Steering items。
- 上下箭头立即调整相同模式中的显示顺序，Server 随后确认权威 Queue state。
- Make follow-up 或 Make steering 立即切换模式；切换后的 message 位于目标模式分组末尾。
- Global settings 决定同类 queued message 按 One at a time 或 All queued 投递。

### 停止运行

Send 与 Stop 始终显示为两个按钮。AI 工作时可以继续发送 Follow-up，也可以点击 Stop 请求当前 Session 中止执行。Session 待机时 Stop 为 disabled。已经记录的 message 和 tool activity 继续保存在 Session 中。

### Fork

含普通 text 或 image 的已完成 assistant item 在内容末尾默认显示 Copy Markdown、Fork session 和 Info；只包含 reasoning 和 toolCall 的 message 不显示操作行。Info 信息栏显示 model、Context 百分比、`I/input token`、`O/output token`、source Message ID 和内部链接。Fork session 从该 text 对应的 session entry 创建分支。AI working 时也可以从已经完成的旧 assistant message 执行 Fork；当前正在流式生成且尚未持久化的 output 不显示 Fork action。确认新 Session 名称后，应用会打开新分支；原 Session 保持原有分支并继续原来的 Agent run。

### Rollback 与 Restore

当前分支最后一条可回退的 user message 显示 Rollback 按钮。settled 后显示 Response interrupted 的 turn 也使用最后一条 assistant/tool message 作为 rollback target，因此该 turn 的 User message 可以回退。

1. 点击 Rollback 并确认。
2. Pi-Ark 移除该 user turn 及其后续 assistant/tool 输出。
3. 原 user message 回到 composer。
4. Composer 上方显示 Restore message。

点击 Restore message 会恢复原分支。编辑并发送替代 message 后，Restore message 消失。Rollback 不修改 Workspace 中的项目文件。

### Copy 与链接

Assistant text 的 Info 信息栏和展开后的 tool item 可以复制 `pi-ark://` message link。持久化 message 使用 Session 内唯一的七字符短 Message ID；单个 Session 的 source entry 上限是 10000000。页面不提供绝对浏览器 message URL 的复制按钮。已完成的 assistant text 可以 Copy Markdown。复制成功后，按钮会短暂显示完成状态。

### 通过 link 引用会话内容

将 Pi-Ark 的 Session link 或 Message link 粘贴到发送给 Agent 的消息中，并说明希望 Agent 阅读或处理的内容。Agent 自带 `read_pi_ark_link`，可以根据链接读取目标，例如：

```text
请阅读这条消息，并根据其中的方案继续开发：
pi-ark://workspace/<workspace-id>/session/<session-id>/message/<message-id>
```

Message link 默认读取指定消息。需要前后文时，可以要求 Agent 同时阅读相邻消息；工具的 `context` 支持前后各最多 20 条消息。Session link 默认读取末尾 20 条消息，Agent 可以通过 `start` 和 `limit` 分页阅读更早或后续的内容。Workspace link（`pi-ark://workspace/<workspace-id>`）可以读取 Session 列表摘要。

工具返回消息的短 Message ID、source entry ID 和正文，并兼容旧数字 Message link。较长的正文会提供 `nextContentOffset`，Agent 可以使用同一个 Message link 和对应的 `offset` 继续读取。单次结果最多为 48 KiB。正文包含 reasoning 和工具过程，图片以 MIME type 说明表示。工具读取当前服务中已经注册的 Workspace，并保持目标 Session 的运行状态与活动分支。

父子 Session 新建和重新打开时均自带 `read_pi_ark_link`，并统一启用文件工具（`read`、`bash`、`edit` 和 `write`）。

### 使用 subagent

在父 Session 中向 Agent 说明可以独立执行的任务，以及每个任务的预期结果。需要参考之前的会话内容时，同时提供内部消息链接与阅读目的。例如：

```text
请使用 subagent 并行分析服务端的任务调度与 Web 的任务状态展示。
服务端的任务预期结果是列出调度流程与对应文件。
Web 的任务预期结果是列出用户可见状态与对应组件。
请在父 Session 中汇总结果。
```

Agent 委派后，父 Session 的状态左侧显示 subagent 的分支 logo 与 `running / complete / total` 数量。`running` 统计正在执行的子 Session，`complete` 统计最新任务已完成的子 Session，`total` 统计保留的子 Session；同一子 Session 的多轮任务合并统计。每次委派支持 1–8 个任务，每个父 Session 最多同时执行 4 个任务，服务实例最多同时执行 8 个任务。

- 点击状态栏的 subagent logo，展开 agent 列表。
- 列表中每个 agent 使用一行，显示标题、状态与最后更新时间，点击该行进入子 Session。
- 上方显示 `queued`（等待执行）与 `running`（正在执行）的 agent，按最后更新时间倒序排列；列表内容较多时可以在列表内滚动。
- 底部的 Completed 分组包含 `completed`（已完成）、`failed`（执行出错）、`cancelled`（已停止）与 `interrupted`（服务中断）的 agent，默认折叠，点击可以展开；新的任务结束时，该分组自动折叠。
- 子 Session 顶部的 Parent Agent 栏显示父会话的标题、状态与 subagent 数量，点击标题返回父会话；点击 Open parent request 返回本轮委派时的父消息。
- 在运行中的子 Session 页面点击 Stop，停止对应任务；在父 Session 中点击 Stop，停止该 Session 当前等待的子任务。
- 需要继续原来的任务时，在父 Session 中要求 Agent 向已有的 subagent 发送后续任务；该 agent 会回到上方的活动列表，并保留原来的会话上下文。

子 Session 始终隐藏输入框，任务输入由 Parent Agent 委派。子会话中的角色名称显示为 `Parent Agent` 与 `SubAgent`，其中包括消息 header、顶部的 sticky header 与消息信息栏；配色与头像沿用原有样式。普通会话继续显示 `User` 与 `AI`。侧栏的 Session 列表展示普通 Session，subagent 通过状态栏的列表进入。

父 Session 自带 `subagent`，子 Session 的后续委派由父 Session 组织。任务使用独立的会话上下文，并共享 Workspace 文件。并行修改任务应明确各任务负责的文件，父 Session 负责组织共同文件的修改与后续交付。再次委派时，Agent 在 `subagent` 的任务参数中提供已有的 `sessionId`，子 Session 沿用自身配置。工具结果保留每轮任务的结果摘录、用量与结果消息链接，父 Session 的 Session information 保留自身的用量。

任务结果与来源链接会保留当时的分支参数 `leafEntryId`。打开后，页面显示 Historical conversation branch，点击 Open current conversation 可以切换到当前对话。父 Session 或子 Session 后续发生 Rollback 时，这些历史链接继续指向原来的消息。

### 查看 Session information

会话状态栏左侧依次显示标题、编辑标题按钮和状态。标题组不占用剩余空间；标题根据实际文字长度占用空间，达到当前上限后截断；编辑按钮紧跟标题。右侧只显示 context 百分比数字和信息按钮。Disconnected、Connection error 和其他错误状态使用完整红灯、红色系底色和边框。移动端的过长状态文字会省略，红灯保持完整显示。点击信息按钮可以查看时间、消息数量、context 使用情况、token 总量和费用，并可以 Copy session URL 或选择 Compact、Wide、Full conversation width。

## Files 页面

Files 页面顶部的目录 breadcrumb 使用整个页面宽度。下方左侧用于目录导航，右侧用于阅读文件；选中文件的路径显示在阅读区域顶部的独立行中。

- 点击目录进入下级路径。
- 点击目录列表顶部的 Up one level 返回父目录。
- 点击 breadcrumb 中的任意目录返回对应路径。
- 拖动桌面端两栏之间的 separator 可以调整文件列表宽度。
- 打开文件或目录右侧的 action menu，可以选择 Copy path（服务器绝对路径）或 Copy relative path（Workspace-relative path）。
- 每个文件的 action menu 和阅读区域 header 都提供 Download。
- Markdown 使用阅读视图，并解析 Workspace 内的相对图片。
- PNG、JPEG、GIF 和 WebP 文件使用图片预览。
- 其他文本文件使用代码视图。
- binary file 或超过预览上限的文件显示 Preview unavailable，并保留 Download file。

是否显示 dotfile 和最大预览大小由 Settings → Workspace → File browser 控制。预览大小默认是 10 MB，可设置范围是 1–100 MB。预览上限不限制下载；`.pi-ark` 内部状态目录始终从 Files 页面隐藏。

## Terminal 页面

首次打开 Terminal 时，Pi-Ark 恢复当前 Workspace 的已有 Tab；列表为空时自动创建首个 Tab。每个 Tab 在 Workspace 目录中运行独立的 shell。Tab 栏使用紧凑的单行布局，标题使用 `Tab 1` 这样的简短名称，活动 Tab 使用中性色背景与细底线。

- 点击 Tab 栏中的加号（New terminal tab）创建新 Tab。
- 点击 Tab 标题切换终端；焦点位于 Tab 标题时，可以使用左右方向键切换，也可以使用 Home 或 End 选择首个或末个 Tab。
- 点击 Tab 的关闭按钮结束对应进程并清理输出；关闭最后一个 Tab 后，点击空状态中的 New terminal 可以重新创建，Refresh tabs 可以读取当前列表。
- 选择终端中的文字后，点击 Copy，或使用复制快捷键（Ctrl+Shift+C 或 Cmd+C）复制选区；成功后，终端区域右上角显示短暂的悬浮提示。
- 使用系统或浏览器的默认粘贴方式将文字粘贴到终端，也可以点击工具栏中的 Paste。
- Ctrl+C 沿用终端程序的中断行为。
- 点击 Fit（Fit terminal）主动适配当前容器，页面尺寸变化时也会自动适配。
- 鼠标悬停、键盘聚焦或点击 Tab 栏右端的 Terminal details（省略号图标），可以查看连接详情；连接中断后，页面自动尝试重连，详情中的 Retry 可以主动重新连接。
- 按 Escape、点击详情外部或再次点击 Terminal details，可以关闭连接详情；切换 Tab 或页面时，详情同样关闭。
- 操作反馈以紧凑的悬浮卡片显示，终端正文的位置保持稳定；成功提示在 2.8 秒后消失，错误提示可以通过关闭按钮收起。

切换 Tab、页面或 Workspace 后返回，Pi-Ark 会立即显示保留的终端界面，包括原来的状态（输出、阅读位置和选区）。Server 在当前运行生命周期内保存每个 Tab 的进程和完整输出，浏览器刷新后重新连接并恢复历史。shell 自然退出后，可以继续查看该 Tab 的输出，直到显式关闭；关闭 Workspace 或 Server shutdown 时，Pi-Ark 释放相关 Terminal 资源。

打开 Settings → Terminal，可以配置新 Tab 使用的 shell，并调整当前浏览器的字体。Terminal 使用 Pi-Ark 服务账号的系统权限，页面顶部显示当前 Workspace 路径。

## Settings

Settings 的 Server 设置对所有 Workspace 使用统一的配置，Terminal 的字体设置保存在当前浏览器中。桌面端从左侧选择类别，移动端从顶部横向导航选择类别。类别按以下顺序显示：

1. Interface
2. Models & providers
3. Agent behavior
4. Files
5. Terminal
6. Maintenance
7. Account

普通选择、开关和完成输入的数值会立即保存。需要确认的内容（API key、Global system prompt append 与 Terminal 的复杂 shell 字段）使用对应区域内的 Save 与 Cancel。

首次进入 Settings 后，浏览器保留已经加载的设置、所选类别、各类别的滚动位置，以及尚未保存的草稿（提示词与 Terminal shell 设置）。切换页面后返回可以继续操作。Refresh settings 会主动重新读取设置。Effective prompt preview 在展开时读取，Terminal shell 配置与 Maintenance 的版本信息在首次进入对应类别时读取。离开 Settings 后，页面会清空尚未提交的 API key。

### Interface

选择以下 theme，选择后会立即预览并保存：

- Ark Dark
- Graphite
- Midnight
- Paper
- Snow

Theme 选择会立即预览，保存后对该 Pi-Ark 服务的浏览器生效。

Hide reasoning 控制所有 Workspace 和 Session 的 reasoning 显示。开启后，conversation 不显示 Reasoning 折叠项和内容；Session history 与模型使用的上下文继续保留原始 reasoning。该开关会立即保存，刷新页面后继续生效。

Keep line breaks（按原文换行）默认开启：原文写成几行，普通文本就按几行显示。关闭后，同一段落内的普通换行会合并显示，使用空行可以分隔段落。该设置统一作用于会话正文、Reasoning、摘要和 Files 的 Markdown 预览，切换后立即保存，刷新后保留选择。

### Models & providers

1. 在 Manage Provider 中选择需要认证或断开的 Provider。模型行右侧的星标继续决定新 Session 的 default。
2. 通过 API key 或 subscription account 完成认证。
3. 在 Models shown in Pi-Ark 中选择需要出现在模型菜单中的模型。模型 checkbox 的填色状态表示启用，空白状态表示关闭。列表按 Provider 分组，并支持搜索。
4. 点击模型行右侧的星标，将已勾选模型指定为新 Session 的 default。选择尚未勾选的模型作为 default 时，Pi-Ark 会同时勾选该模型。
5. 选择 default model 支持的 Default thinking level。

模型 checkbox、default 和 Default thinking level 在选择后立即保存。切换普通模型的启用状态时，当前 default 和 Default thinking level 保持原值。关闭 default 模型时，Pi-Ark 从列表中选择第一个仍启用的模型作为新 default，并调整 thinking level 以匹配新 default。最后一个启用的模型保持启用，页面显示 Select at least one model 提示。已有 Session 会继续恢复它记录的当前模型；如果该模型后来取消勾选，composer 仍显示当前的 `provider/model` reference，模型菜单显示当前已勾选的模型。API key 输入是 write-only；输入后使用该区域内的 Save API key 或 Cancel。浏览器接收 credential 状态与来源，credential 内容保存在服务端。

使用保存 credential 的 Provider 会显示 Disconnect。确认后，Pi-Ark 删除 `auth.json` 中该 Provider 的 credential。环境变量或 `models.json` 提供的认证继续由对应配置管理；Disconnect 的显示条件是 credential source 为 stored。断开后，Pi-Ark 保留仍可用的已勾选模型；如果没有剩余的已勾选模型，Pi-Ark 选择第一个仍可用模型作为模型清单和 default。

支持 subscription OAuth 的 Provider 会显示 Use subscription account。登录区可能显示授权链接、device code、文本输入、选择项或进度。Device code 可以使用旁边的 Copy 按钮复制。OpenAI 的 Sign in with ChatGPT 会自动使用当前 Pi-Ark 安装实例的 UUID，用户不需要输入该标识。同一个 Provider 重新开始登录时，Pi-Ark 会取消此前仍在等待的登录；页面刷新后可以直接重新开始。

### Agent behavior → System prompt

在 Global append content 中编辑共享的说明，并点击 Save system prompt。Cancel 恢复已保存的内容。保存空文本可以清除全局追加内容。该设置在新建或重新打开 Session 时生效。

展开 Preview effective prompt，可以查看 pi 生成的 complete effective prompt，以及可选的 replacement file 和 append file 路径。

默认文件位置：

```text
PI_ARK_AGENT_DIR/SYSTEM.md
PI_ARK_AGENT_DIR/APPEND_SYSTEM.md
```

在服务器编辑文件后点击 Refresh。Preview 还包含 pi 内置说明、tools、context files、skills 和当前 Workspace path，其中的文件工具与 Session 一致（`read`、`bash`、`edit` 和 `write`）。

### Agent behavior → Agent defaults

- Steering messages：One at a time 或 All queued。
- Follow-up messages：One at a time 或 All queued。
- Automatic compaction：接近 context limit 时压缩旧上下文。
- Automatic retry：按 pi 默认行为重试临时 provider failure。

以上选择和开关会立即保存。

### Files

Show hidden files 控制所有 Workspace 的普通 dotfile 是否进入 Files 列表，切换后立即保存。Maximum preview size 控制文本、Markdown 和支持图片的预览上限，默认是 10 MB，可设置范围是 1–100 MB；输入完成并离开输入框后保存，超过该值的文件仍可下载。

### Terminal

Terminal 类别位于 Files 之后、Maintenance 之前。Server shell 区域显示 Server platform，并提供 Shell profile 选择器。该配置由所有 Workspace 和浏览器共享，保存后在新建 Tab 时生效；已有 Tab 继续使用启动时的 shell。

Auto 按服务器的操作系统选择 shell：

- Windows：优先使用 PowerShell（pwsh），其次使用 Windows PowerShell。
- macOS：优先使用有效的 `SHELL`，其次使用 `/bin/zsh`。
- Linux：优先使用有效的 `SHELL`，其次使用 `/bin/bash`。

Shell profile 同时列出服务器上已发现的可用程序（Bash、Zsh、Fish、PowerShell、Windows PowerShell、Git Bash 和 WSL）。其他字段保持已保存内容时，选择普通 profile 会立即保存。需要指定程序或附加配置时，按以下步骤操作：

1. 使用自定义程序时，选择 Custom executable，并在 Custom shell executable 中填写服务器上可执行文件的绝对路径，例如 `/bin/bash` 或 `C:\Program Files\PowerShell\7\pwsh.exe`。
2. 在 Additional shell arguments (JSON array) 中填写字符串数组，例如 `["-l"]`；`[]` 使用 profile 的默认参数。每个字符串作为独立的附加参数传入程序。
3. 在 Environment variables 中按每行 `KEY=VALUE` 填写环境变量。值按原文保存，支持空格和额外的等号，例如 `MY_VARIABLE=value=with=equals`。
4. 点击 Save shell settings 保存，或点击 Cancel 恢复已保存的值。
5. 返回 Terminal 并创建新 Tab，以使用保存后的配置。

PowerShell 启动时将输入与输出编码设置为 UTF-8，Unix 会继承有效的 UTF-8 locale；Environment variables 中的值覆盖继承的环境变量。Terminal 配置首次进入时加载，之后保留在页面缓存中。在该类别点击 Refresh settings 会更新 Server 配置与可用 profiles，同时保留尚未保存的草稿；Cancel 可以切换到刷新后的已保存内容。

Browser appearance 区域的 Font family 与 Font size 保存在当前浏览器中，修改后立即应用到已打开的 Terminal Tab。Font family 使用以逗号分隔的字体名称，支持带引号的字体名称；默认列表为 `ui-monospace, "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace`，浏览器使用本机的等宽字体，并为中文字符选择可用的备用字体。历史默认列表在读取时采用新的默认字体，同时保留已保存的字号；自行设置的其他字体列表继续使用原值。Font size 默认是 13 px，可设置为 10–30 px。Reset font defaults 恢复默认的字体列表和字号。

Keyboard shortcuts 区域说明系统的默认粘贴行为，以及工具栏的 Copy 和 Paste 操作。复制选区可以使用 Ctrl+Shift+C 或 Cmd+C，Ctrl+C 沿用终端程序的中断行为。

### Maintenance

Pi-Ark release 区域显示以下信息：

- Pi-Ark version 与 bundled pi core version。
- Release 或 development checkout 的 install mode。
- Stable 或 development channel、latest release 和 previous release。
- Install path、Global data path、Pi-Ark agent data path 和 pi core package path。
- Update、rollback、status、logs 和 restart 的完整 Node 调用命令，指向安装目录中的稳定 CLI。

Check for updates 查询 GitHub Releases 的 latest stable release。Update Pi-Ark 下载当前操作系统与 architecture 的完整 artifact，在安装前运行 dependency preflight，保留当前 release 为 `previous`，再切换 `current`。POSIX 使用 symlink 保存 release state，Windows 使用 `release-state.json` 保存绝对路径。Roll back 将 `current` 与 `previous` 对调。两个操作都保留 Global data 与 Workspace data。

Web 更新或回退的响应返回后，Server 正常关闭。Portable 后台管理器或 Linux 系统安装的 supervisor 从当前 release 重新启动，并请求 `/api/health`；启动检查失败时，管理器恢复 previous release。

Development checkout 或带 `dev` prerelease 的本机安装会显示 development channel，并隐藏 stable update 操作。Update Pi-Ark 需要从 stable release 安装运行。更新或回退期间应保存当前输入，并预期现有连接在 service 重启时断开。

### Account

点击 Sign out 结束当前浏览器的登录会话。

## 浏览器布局设置

桌面侧栏 separator 上的箭头用于折叠和展开。拖动 separator 可以调整侧栏宽度。

以下偏好保存在当前浏览器的 localStorage：

- 侧栏折叠状态。
- 侧栏宽度。
- Files 文件列表宽度。
- Workspaces 展开状态。
- Conversation width。
- 最近应用的 theme。
- Terminal 的字体列表和字号。
- 每个 Workspace 最近选择的 Terminal Tab。

移动端通过顶部菜单按钮打开 drawer sidebar。drawer 打开后，遮罩覆盖页面 header、composer 和 drawer 之外的其他应用内容；点击遮罩可以关闭 drawer。Chat 主列限制在屏幕宽度内，状态栏、conversation、sticky User row、Running 和 composer 不会向屏幕右侧溢出。

## Service 管理与 release 更新

使用安装器输出的稳定 CLI 完整路径。以下 `<prefix>` 对应安装时的应用目录，非 default instance 的 CLI 使用对应名称（例如 `pi-ark-dev.mjs`）：

```text
node "<prefix>/bin/pi-ark.mjs" start
node "<prefix>/bin/pi-ark.mjs" stop
node "<prefix>/bin/pi-ark.mjs" restart
node "<prefix>/bin/pi-ark.mjs" status
node "<prefix>/bin/pi-ark.mjs" logs
node "<prefix>/bin/pi-ark.mjs" update
node "<prefix>/bin/pi-ark.mjs" rollback
```

Portable 的 `start` 在后台启动，`stop` 通过本机管理通道请求停止，`restart` 先停止再启动。关闭启动终端后，服务继续运行。`status` 显示运行状态、health、release 与数据路径；`logs` 显示已有日志，`logs --follow` 持续显示新增日志。使用 `serve` 可以在当前终端前台运行。

例如，macOS 可以执行 `node "$HOME/Library/Application Support/Pi-Ark/app/bin/pi-ark.mjs" status`，Windows PowerShell 可以执行 `node "$env:LOCALAPPDATA\Pi-Ark\app\bin\pi-ark.mjs" status`。

Linux 的系统安装通过 systemd 执行 start/stop/restart，`status` 显示 service 状态，`logs` 持续显示 service journal。双实例的 command name 分别为 `pi-ark-dev` 与 `pi-ark-backup`。

`update` 安装 GitHub latest stable release，`rollback` 恢复 previous release，随后重新启动并执行 health check。`--no-restart` 可以将 release 切换与重启分开安排。两个操作都保留 Global data 与 Workspace data。

## 从 dev 实例到正式发布上线

发布命令在 source checkout 中执行，使用已经确认的开发源码。开发 artifact 的 `RELEASE.json` 记录 `sourceCommit` 与 `sourceDirty`，发布准备通过实际运行进程取得来源。首次采用这套流程时，先从包含发布工具的已提交源码构建并确认开发版本。

### 准备候选版本

在 Linux 开发主机的 source checkout 中执行：

```bash
VERSION="0.1.6"
npm run release:prepare -- --version "$VERSION"
```

命令默认读取 `pi-ark-dev.service` 的实际进程，固定运行版本的源码，随后在 `.tmp/release-process/<version>/source` 创建隔离的 Git worktree。命令会将项目与 workspace 的 package/lock 版本改为目标正式版本，创建 commit，并推送 `release/<version>` 候选分支。开发分支继续保留当前的内容，后续的并发开发也可以继续进行。

自定义开发实例使用 `--prefix <安装目录> --service-name <unit>`。其他平台或已经由发布负责人确认的源码，使用以下入口：

```bash
npm run release:prepare -- --version "$VERSION" --source <已确认的 Git ref>
```

来源源码应包含当前的发布工具与原生构建 workflow。旧 artifact 的来源可以通过原构建记录确认，再使用 `--source`；新的开发构建会自动保存来源记录。

### 等待原生构建并处理错误

```bash
npm run release:status -- --version "$VERSION" --watch
```

状态命令显示各个平台的构建步骤与 Actions 链接。失败时，命令直接输出失败的 job 与具体的命令错误。CI 命令默认在 10 分钟后超时，错误摘要会保留该命令最后的输出。当前流程完成后，命令结束轮询；再次执行相同命令可以继续查询。查询使用公开的 GitHub API，也可以通过 `GH_TOKEN` 或 `GITHUB_TOKEN` 提供 API token；Git push 沿用已有的 Git 配置。有 token 时默认每 30 秒查询，匿名查询时默认每 180 秒查询，`--interval <秒>` 可以调整间隔。

构建与安装 smoke 完成后，每个平台上传对应的候选安装包。正式发布将复用该次构建的安装包。

### 修正候选或恢复中断

连接或进程中断后，重复执行相同的 `release:prepare` 可以继续准备和推送，随后使用 `release:status --watch` 查询。来源记录与恢复状态保存在 `.tmp/release-process/<version>/state.json`，运行期间的临时内容也保存在项目的 `.tmp/` 中。

正式发布之前需要修正源码时，先提交修正并确认新的开发源码，再执行：

```bash
npm run release:prepare -- --version "$VERSION" --source <新的已确认的 Git ref> --refresh
npm run release:status -- --version "$VERSION" --watch
```

`--refresh` 为同一目标版本生成后续的候选 merge commit，并以 fast-forward 推送。它保留旧候选与新来源的 Git 历史，新候选的文件内容对应新来源加正式版本更新。其他 checkout 可以通过候选分支恢复来源记录。发生中断时，重复相同的命令或普通的 `prepare` 可以继续完成该次更新。正式 tag 创建后，该版本沿用已发布的来源；后续的源码修改进入下一个版本。

### 发布正式安装包

在候选完成后执行：

```bash
npm run release:publish -- --version "$VERSION" --watch
```

命令核对源码与版本，并确认原生安装包齐全，随后创建并推送 annotated `v<version>` tag。Tag workflow 下载对应成功候选的安装包，核对文件名与版本，再发布 GitHub Release。状态命令确认正式 Release 的类型、tag 和非空安装包清单后，显示正式发布已完成。

重复执行 `release:publish` 可以确认已经完整交付的同一正式版本。需要继续查看进度时，执行 `release:status --watch`；正式发布 job 失败时，可以在输出的 Actions 链接中重新运行该 job，再继续查询。

### 将正式版本上线到选定实例

正式 Release 完成后，在选定实例上使用安装时输出的稳定 CLI 更新到 latest stable release：

```text
node "<prefix>/bin/pi-ark.mjs" update
node "<prefix>/bin/pi-ark.mjs" status
```

非 default instance 使用对应的 CLI 文件名。指定版本的安装可以下载对应的正式安装包，再使用[安装与初始化](#安装与初始化)中的安装器参数保留该实例的 prefix 和 data directory。主力开发实例从自身 Session 安装时，按[开发模式](#开发模式)中的自替换步骤完成重启前的确认，并使用 `--deferred-restart <seconds>` 安排 systemd timer，随后返回结果。

从独立的管理终端执行更新时，上线后确认 `/api/health`、实际运行路径与 Settings → Global → Maintenance 中的运行版本。Linux 系统安装可以通过 systemd MainPID 定位实际的 Server 子进程，再核对该进程命令行中的 Server 入口与对应的 artifact。需要恢复上一版本时，执行稳定 CLI 的 `rollback`，再确认 health 与运行版本。发布工作区和实例安装状态分别保存，实例管理员按选定的上线安排执行更新。

## 数据位置与备份

安装状态位于 `<prefix>/install.json`，其中保存 Node 路径与实例环境。POSIX 的 `<prefix>/current` 与 `<prefix>/previous` 指向当前及上一 release；Windows 的 `<prefix>/release-state.json` 保存对应的绝对路径。Portable 的管理器状态位于 `<prefix>/run/daemon.json`，运行日志位于 `<prefix>/logs/pi-ark.log`。

Global data：

```text
PI_ARK_HOME/
  config.json
  tls/
  pi-agent/
    auth.json
    settings.json
    models.json
    SYSTEM.md
    APPEND_SYSTEM.md
```

Workspace data：

```text
<workspace>/.pi-ark/
  config.json
  notebook.md
  sessions-meta.json
  attachments/
  sessions/
```

备份时应同时保存 `PI_ARK_HOME` 和需要保留的 Workspace `.pi-ark` 目录。`auth.json`、TLS private key 和密码摘要属于敏感数据。

## 常见问题

### 浏览器提示证书不受信任

初始化命令默认生成自签名证书。开发环境可以在浏览器中确认该证书；生产环境应在 `config.json` 中配置受信任的 certificate 和 private key。

### Add workspace 拒绝目录

确认路径是绝对路径、目录已经存在，并且 Pi-Ark 服务账号具有访问权限。

### Provider 显示 Authentication required

在 Settings → Global → Provider and model 中输入 API key，或为支持 subscription 的 Provider 完成 subscription login。认证完成后，在模型清单中勾选需要使用的模型并指定 default。

### Session 长时间显示 Loading conversation

Loading conversation 等待首个 WebSocket snapshot。检查浏览器到 `/ws/agent/...` 的连接、服务日志和 Session JSONL 的读取权限。

### Terminal 显示 Disconnected

打开 Tab 栏右端的连接详情，点击 Retry，并检查浏览器到 `/ws/terminal/:workspaceId/:terminalId` 的连接、node-pty 安装状态和服务账号的 shell 权限。需要更换 shell 时，在 Settings → Terminal 保存配置后创建新 Tab。

### System prompt preview 未更新

确认编辑的是页面显示的 `PI_ARK_AGENT_DIR` 文件路径，然后点击 Refresh。已经打开的 agent runtime 需要重新打开，才能使用新的 Global append。
