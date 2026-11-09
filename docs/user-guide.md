# Pi-Ark 使用手册

## 环境要求

- Node.js 22.19 或更新版本。
- npm。
- OpenSSL。
- node-pty 所需的本机构建环境。
- Pi-Ark 服务账号可以访问的 Workspace 目录。
- 可用的 provider API key 或 subscription account。

## 安装与初始化

从 GitHub Releases 下载与服务器 architecture 对应的 artifact（Linux x64 或 Linux arm64），然后执行：

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

Installer 创建以下运行结构：

```text
/opt/pi-ark/current -> /opt/pi-ark/releases/<version>
/var/lib/pi-ark/
/etc/systemd/system/pi-ark.service
/usr/local/bin/pi-ark
```

现有安装可以通过 `sudo node scripts/install-release.mjs --migrate-data /path/to/existing-data` 复制 Global config、TLS 和 pi agent data。Installer 默认创建专用的 `pi-ark` service account；所有已注册的 Workspace 都需要允许该账号访问。

初始化命令支持以下参数：

| 参数 | 作用 | 默认值 |
|---|---|---|
| `--username` | 登录用户名 | 必填 |
| `--password` | 登录密码 | 必填 |
| `--workspace` | 初始 Workspace 的绝对路径 | 当前目录 |
| `--id` | 初始 Workspace ID | 目录名称 |
| `--name` | 初始 Workspace 显示名称 | Workspace ID |
| `--host` | HTTPS 监听地址 | `127.0.0.1` |
| `--port` | HTTPS 监听端口 | `31415` |

`PI_ARK_HOME` 可以修改 Pi-Ark data directory，默认位置是 `~/.pi-ark`。`PI_ARK_AGENT_DIR` 可以修改 Pi-Ark 专用的 pi agent data directory，默认位置是 `PI_ARK_HOME/pi-agent`。

浏览器打开初始化命令输出的 HTTPS 地址。使用自签名证书时，首次访问需要在浏览器中确认该证书。

## 开发模式

从 source checkout 开发时运行：

```bash
npm install
npm run setup -- --username ark --password 'choose-a-password' --workspace /absolute/path/to/workspace
npm run dev
```

Vite 默认使用 `http://localhost:5173`，并将 API 和 WebSocket 请求转发给本地 Pi-Ark HTTPS 服务。

日常迭代使用 `<next-version>-dev.<iteration>` 版本。每次迭代完成后，本机服务从对应的 `/opt/pi-ark/releases/<dev-version>` 运行；该流程不创建 Git tag 或 GitHub Release。正式 release 仅在明确安排发布时创建。

常用项目命令：

```bash
npm run build
npm run check
npm run check:behavior
npm run check:ui
npm run release:build
npm start
```

## 登录与退出

登录页使用初始化时配置的用户名和密码。登录成功后，浏览器获得 Secure、HttpOnly 和 SameSite=Strict cookie。

退出入口位于 Settings → Global → Account。退出后，当前浏览器 cookie 失效并返回登录页。

## 修改登录密码

交互式修改密码：

```bash
pi-ark password
```

`pi-ark passwd` 是相同命令的简写。命令默认更新 `PI_ARK_HOME/config.json` 并重启正在运行的 `pi-ark.service`。

指定配置文件或延后重启：

```bash
pi-ark password --config /path/to/config.json --no-restart
```

自动化环境可以使用：

```bash
PI_ARK_NEW_PASSWORD='new-password' pi-ark password --no-restart
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

点击侧栏中的 Workspace。Agent、Files、Terminal 和 Workspace settings 会切换到该目录。

### 重命名 Workspace

打开 Workspace 行的操作菜单并选择 Rename。此操作只修改显示名称。

### 关闭与重新打开 Workspace

选择 Close 并确认后，Workspace 从侧栏和 Global registry 中移除。服务器目录、项目文件、`.pi-ark` settings、附件和 Session 保持原状。

再次通过 Add workspace 添加相同目录后，原有 Session 和 settings 会重新出现。

## Session 操作

### 新建 Session

点击 Sessions 标题旁的加号。新 Session 会立即打开；首次发送 message 后，Session 列表使用首条 user message 作为默认标题。

### 管理 Session

打开 Session 行的操作菜单可以执行以下操作：

- Rename：设置便于查找的标题。
- Copy session link：复制 Pi-Ark 内部链接。
- Manage groups：选择一个或多个 Session group。
- Pin 或 Unpin：调整活跃 Session 的置顶状态。
- Archive 或 Restore：移动到 Archived 区域或恢复。
- Delete：删除 conversation file、metadata 和 Session 附件。

Delete 会影响 Session 数据。确认对话框会显示即将删除的 Session 名称。

### 使用 Session group

点击 New group 创建 group。每个 group 可以重命名或删除。Manage groups 允许同一个 Session 同时加入多个 group。

### 打开内部链接

点击 Sessions 标题旁的链接按钮，粘贴以下形式的链接：

```text
pi-ark://workspace/<workspace-id>/session/<session-id>
pi-ark://workspace/<workspace-id>/session/<session-id>/message/<message-number>
```

目标 Workspace 必须已经在当前服务中打开。Message link 会定位并高亮对应 message。

## 使用 Agent

### 等待 Session 加载

打开 Session 后，页面先显示 Loading conversation。首个 snapshot 到达后，composer 和 conversation controls 才会出现。较长 Session 的加载进度采用持续移动的进度条。

### 发送 message

在 composer 中输入内容并按 Enter。使用 Shift+Enter 添加换行。输入法候选状态中的 Enter 不会发送 message。

输入框最多展开到十行，之后在输入框内部滚动。Composer 在 Compact、Wide 和 Full 模式下保持相同宽度；这些模式调整 conversation message 区域。

### 选择当前 Session 的 model

Composer 底部提供 Model 和 Thinking 选择器。选项来自已经配置凭证的 model，以及 pi 为所选 model 声明的 thinking capability。

这里的选择只更新当前 Session。新 Session 的默认值在 Settings → Global 中设置。

### 添加附件

点击回形针按钮选择文件，或将剪贴板图片粘贴到 composer。

限制如下：

- 每条 message 最多 8 个附件。
- 单个附件最大 10 MB。
- 所有附件总大小最大 20 MB。
- 图片预览支持 PNG、JPEG、GIF 和 WebP。

发送前可以从附件队列中删除文件。附件发送后保存在 `<workspace>/.pi-ark/attachments/<session>/`，prompt 会包含对应服务器路径。

### 查看工具过程

已完成的工具执行默认显示为一个 run collapse，summary 包含用时和工具消息数量。展开 run 后，每个 tool call 和 tool result 仍然保持在独立的关闭框中。

Reasoning 可以通过自己的 disclosure 展开。展开 Call 可以查看 arguments；展开 Result 可以查看输出。Failed 表示工具返回错误。

历史 turn 如果在 final assistant response 之前停止，会显示 Response interrupted warning。其工具活动仍然可以通过相同的折叠框查看。

### Queue

Pi 正在工作时发送的新 message 会显示在 Queue。每个 queued message 标记为 Steering 或 Follow-up。

- 上下箭头在相同模式中调整顺序。
- Make follow-up 或 Make steering 切换模式。
- Global settings 决定同类 queued message 按 One at a time 或 All queued 投递。

### 停止运行

Pi 工作时，Send 按钮变为 Stop。点击 Stop 会请求当前 Session 中止执行。已经记录的 message 和 tool activity 继续保存在 Session 中。

### Fork

Assistant response footer 的 Fork session 从该 response 对应的 session entry 创建分支。确认新 Session 名称后，应用会打开新分支；原 Session 保持原有分支。

### Rollback 与 Restore

当前分支最后一条可回退的 user message 显示 Rollback 按钮。

1. 点击 Rollback 并确认。
2. Pi-Ark 移除该 user turn 及其后续 assistant/tool 输出。
3. 原 user message 回到 composer。
4. Composer 上方显示 Restore message。

点击 Restore message 会恢复原分支。编辑并发送替代 message 后，Restore message 消失。Rollback 不修改 Workspace 中的项目文件。

### Copy 与链接

每条 message header 可以复制浏览器 URL 或 Pi-Ark 内部链接。Assistant response footer 可以 Copy Markdown。复制成功后，按钮会短暂显示完成状态。

### 查看 Session information

点击 header 的信息按钮可以查看时间、消息数量、context 使用情况、token 总量和费用。

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

Terminal 连接后在当前 Workspace 目录中启动 shell。连接状态显示在页面 header；Fit terminal 可以重新适配当前容器大小。

Terminal 使用 Pi-Ark 服务账号的系统权限。运行命令前应确认服务账号权限和当前 Workspace 路径。

## Settings

Settings 中的普通选择、开关和完成输入的数值会立即保存。页面底部没有统一 Save 按钮。API key 和 Workspace system prompt append 需要明确确认，因此 Save 与 Cancel 位于对应区域内。

### Global → Appearance

选择以下 theme，选择后会立即预览并保存：

- Ark Dark
- Graphite
- Midnight
- Paper
- Snow

Theme 选择会立即预览，保存后对该 Pi-Ark 服务的浏览器生效。

### Global → Provider and model

1. 选择 Provider。
2. 通过 API key 或 subscription account 完成认证。
3. 选择 Model。
4. 选择该 Model 支持的 Thinking level。

已经认证的 Provider、Model 和 Thinking level 在选择后立即保存。API key 输入是 write-only；输入后使用该区域内的 Save API key 或 Cancel。已经保存的 credential 不会返回浏览器。

支持 subscription OAuth 的 Provider 会显示 Use subscription account。登录区可能显示授权链接、device code、文本输入、选择项或进度。Device code 可以使用旁边的 Copy 按钮复制。

### Global → Installation and maintenance

Pi-Ark release 区域显示以下信息：

- Pi-Ark version 与 bundled pi core version。
- Release 或 development checkout 的 install mode。
- Stable 或 development channel、latest release 和 previous release。
- Install path、Global data path、Pi-Ark agent data path 和 pi core package path。
- Update、rollback、status、logs 和 restart 命令。

Check for updates 查询 GitHub Releases 的 latest stable release。Update Pi-Ark 下载当前 Linux architecture 的完整 artifact，在安装前运行 dependency preflight，保留当前 release 为 `previous`，原子切换 `current`，然后重启 service。Roll back 将 `current` 与 `previous` 对调。两个操作都保留 Global data 与 Workspace data。

Development checkout 或带 `dev` prerelease 的本机安装会显示 development channel，并隐藏 stable update 操作。Update Pi-Ark 需要从 stable release 安装运行。更新或回退期间应保存当前输入，并预期现有连接在 service 重启时断开。

### Global → System prompt

页面显示可选的 replacement file 和 append file 路径，以及 pi 生成的 complete effective prompt。

默认文件位置：

```text
PI_ARK_AGENT_DIR/SYSTEM.md
PI_ARK_AGENT_DIR/APPEND_SYSTEM.md
```

在服务器编辑文件后点击 Refresh。Preview 还包含 pi 内置说明、tools、context files、skills 和当前 Workspace path。

### Global → Agent defaults

- Steering messages：One at a time 或 All queued。
- Follow-up messages：One at a time 或 All queued。
- Automatic compaction：接近 context limit 时压缩旧上下文。
- Automatic retry：按 pi 默认行为重试临时 provider failure。

以上选择和开关会立即保存。

### Workspace → System prompt append

该文本在 pi 加载 Global prompt 资源后追加。编辑完成后使用该区域内的 Save system prompt；Cancel 恢复已经保存的内容。保存空文本可以清除 Workspace append。

### Workspace → Agent tools

可以选择 read、bash、edit 和 write。至少需要保留一个 tool。选择后立即保存，并在新建或重新打开 Session 时生效。

### Workspace → File browser

Show hidden files 控制普通 dotfile 是否进入 Files 列表，切换后立即保存。Maximum preview size 控制文本、Markdown 和支持图片的预览上限，默认是 10 MB，可设置范围是 1–100 MB；输入完成并离开输入框后保存，超过该值的文件仍可下载。

## 浏览器布局设置

桌面侧栏 separator 上的箭头用于折叠和展开。拖动 separator 可以调整侧栏宽度。

以下偏好保存在当前浏览器的 localStorage：

- 侧栏折叠状态。
- 侧栏宽度。
- Files 文件列表宽度。
- Workspaces 展开状态。
- Conversation width。
- 最近应用的 theme。

移动端通过顶部菜单按钮打开 drawer sidebar。drawer 打开后，遮罩覆盖页面 header、composer 和 drawer 之外的其他应用内容；点击遮罩可以关闭 drawer。

## Service 管理与 release 更新

```bash
pi-ark status
pi-ark logs
pi-ark restart
pi-ark update
pi-ark rollback
```

`status` 显示 systemd service 状态，`logs` 持续显示 service journal，`restart` 重启 service。`update` 安装 GitHub latest release，`rollback` 恢复 previous release。

## 数据位置与备份

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

在 Settings 中输入 API key，或为支持 subscription 的 Provider 完成 subscription login，然后保存 Global settings。

### Session 长时间显示 Loading conversation

Loading conversation 等待首个 WebSocket snapshot。检查浏览器到 `/ws/agent/...` 的连接、服务日志和 Session JSONL 的读取权限。

### Terminal 显示 Disconnected

检查 `/ws/terminal/...` 连接、node-pty 安装状态和服务账号的 shell 权限。

### System prompt preview 未更新

确认编辑的是页面显示的 `PI_ARK_AGENT_DIR` 文件路径，然后点击 Refresh。已经打开的 agent runtime 需要重新打开，才能使用新的 Workspace append 和 tools。
