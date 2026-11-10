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

同一个 hostname 的双实例可以使用以下独立布局：

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
| `--cli-name <name>` | 设置安装到 `/usr/local/bin` 的 CLI command |
| `--prefix <path>` | 设置 release installation prefix |
| `--data-dir <path>` | 设置独立的 Global data directory |
| `--port <number>` | 修改已有或迁移后的 Global config 中的 listen port |
| `--deferred-restart <seconds>` | 使用 transient systemd timer 延后重启当前实例 |

`--port` 需要 data directory 或 `--migrate-data` source 已经包含 `config.json`；fresh installation 在后续 `setup --port <number>` 中设置 listen port。`PI_ARK_BASE_PATH` 不包含末尾的 `/`。Browser URL 使用包含末尾 `/` 的路径，例如 `/pi-ark/`。实例分别保存 Global settings、provider credentials、pi agent data 和 auth sessions。Workspace 中的 `.pi-ark` 目录可以由两个实例共享；同一个 Session 在同一时刻由一个实例操作。

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

日常迭代使用 `<next-version>-dev.<iteration>` 版本。双实例部署中的主力开发版从 `/opt/pi-ark-dev/releases/<dev-version>` 运行；备用正式版从 `/opt/pi-ark-backup/releases/<release-version>` 运行。日常流程不创建 Git tag 或 GitHub Release。正式 release 仅在明确安排发布时创建。主力开发版从自身 Session 发起安装时使用 `--deferred-restart <seconds>`，当前 request 先返回，systemd 随后重启 `pi-ark-dev.service`。

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
pi-ark-dev password
```

`pi-ark-dev passwd` 是相同命令的简写。该 command 更新 `/var/lib/pi-ark-dev/config.json` 并重启 `pi-ark-dev.service`。备用实例使用 `pi-ark-backup password`。

指定配置文件或延后重启：

```bash
pi-ark-dev password --config /path/to/config.json --no-restart
```

自动化环境可以使用：

```bash
PI_ARK_NEW_PASSWORD='new-password' pi-ark-dev password --no-restart
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

首次打开 Session 时，页面先显示 Loading conversation。首个 snapshot 到达后，composer 和 conversation controls 才会出现。较长 Session 的加载进度采用持续移动的进度条。浏览器在内存中保存最近五个 Session 的 snapshot 和 UI state；切回这些 Session 时会立即显示已有 conversation，并以 Refreshing conversation 状态在后台取得 Server snapshot。UI state 会恢复 composer 中尚未发送的 text、attachments，以及 Running、Tool、Reasoning、Compact 和 Message Info 的展开状态。浏览器刷新会清空该内存 cache。

长会话的初始 Server snapshot 默认只包含最新约 100 条 messages。点击顶部 Show earlier messages 会向 Server 请求 earlier messages，并逐页扩展当前 display window，直至看到完整活动 branch。

### 发送 message

Composer 为空时显示 `Send message here`。在 composer 中输入内容并按 Enter。使用 Shift+Enter 添加换行。输入法候选状态中的 Enter 交给输入法处理。发送后，user message 会立即显示在 conversation 中。

输入框最多展开到十行，之后在输入框内部滚动。Composer 在 Compact、Wide 和 Full 模式下保持相同宽度；这些模式调整 conversation message 区域。Conversation 在页面位于底部附近时跟随新输出；向上滚动后，页面保留当前阅读位置。当前 turn 的 user message 越过顶部后会固定显示在 conversation 顶部；向上滚动到原 message 时，顶部 bar 会立即切换到前一个 user message。点击顶部 User bar 的任意位置可以返回原 message。

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

每条 User message 在 turn 起点显示为全宽色带，其中包含用户头像、`User` 标签、message number、内部链接和可用的 Rollback。色带使用与 conversation 底色有区分的背景，只有上、下 separator，没有左右边框、圆角或阴影，并延伸到 conversation 内容列的左右边界。Separator 与上下内容之间保留更大的间距。色带内部的左侧和上侧留白略大于右侧和下侧。每个 theme 都使用与自身背景协调的 User 颜色，并与 AI 颜色保持区分；User 与 AI 的头像和名称都使用更大的尺寸。每轮 AI response 只在开头显示一次 AI 头像和 `AI` 标签。角色头像只占用 header 行，后续内容继续使用 conversation 的完整宽度。普通文字、图片、reasoning、tool 与 Compact 内容按原始顺序组成连续 feed，不再为每条 assistant message 显示独立卡片。Reasoning 使用较小字号和与普通 text 一致的行高。

AI 运行期间，commentary、tool call 和 tool result 显示在带 Running 状态的 run collapse 中。没有已保存状态时，Running 默认展开，其中正在执行和已经完成的 tool items 都默认关闭；用户可以手动展开 tool item。AI 完成后，该 run collapse 自动折叠，summary 显示用时和工具消息数量，最后一条非工具内容保持展开。展开 run 后，用时 summary 会以不透明背景固定显示在顶部 User bar 下方。切换 Session 后再返回时，页面恢复用户后来手动调整的 Running、Tool、Reasoning、Compact 和 Message Info 状态。

每个 tool call 与 result 合并为一行工具项。工具 logo 位于折叠框内，后面显示工具名称、command/path/arguments 摘要和 Running、Completed、Failed 或 Result 状态。Running、Failed、Result 和 Saved 分别使用不同的 theme color，Completed 使用中性色。Running 与其他状态使用相同的单层 row 结构；Tool permalink 通过 row 内侧的 accent 标识 target。Dark themes 使用更清楚的折叠条背景和边框，使 Running、Tool 与 Reasoning summary 和 conversation 底色区分。连续工具项使用紧凑间距。展开内容与折叠框左边界对齐；第一行显示 Call 与 Result 的全局 message number，并提供对应的 `pi-ark://` link copy 按钮。Arguments 按字段显示，每个 key 使用 heading 样式，下一行显示 value，嵌套 object/array 使用缩进文本，空 arguments 显示 `No arguments`；Result 显示文字或图片结果。

Text item 直接显示普通文字、图片和 reasoning。含普通 text 或 image 的已完成 assistant item 在内容末尾默认显示 Copy Markdown、Fork session 和 Info；对应的流式 item 显示 Info。只包含 reasoning 和 toolCall 的 message 不显示这些操作。点击 Info 后，信息栏显示 model、context、input/output token、source message number 与 `pi-ark://` link；流式输出期间的信息栏只显示当前可用的信息。User header 提供内部链接与 Rollback。

Agent settled 后，如果历史 turn 缺少最后一条非工具内容，页面会显示紧凑的单行 Response interrupted warning。对应工具活动仍然可以通过折叠框查看。

Compact 使用与工具相同的单行折叠项。该行显示 compact 前的 token 数量和 Saved 状态；展开后显示 source message number、内部链接和 compact summary。compact 前的原始 messages 继续保留在会话中，并通过 Show earlier messages 逐页显示。

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

含普通 text 或 image 的已完成 assistant item 在内容末尾默认显示 Copy Markdown、Fork session 和 Info；只包含 reasoning 和 toolCall 的 message 不显示操作行。Info 信息栏显示 model、Context 百分比、`I/input token`、`O/output token`、source message number 和内部链接。Fork session 从该 text 对应的 session entry 创建分支。AI working 时也可以从已经完成的旧 assistant message 执行 Fork；当前正在流式生成且尚未持久化的 output 不显示 Fork action。确认新 Session 名称后，应用会打开新分支；原 Session 保持原有分支并继续原来的 Agent run。

### Rollback 与 Restore

当前分支最后一条可回退的 user message 显示 Rollback 按钮。settled 后显示 Response interrupted 的 turn 也使用最后一条 assistant/tool message 作为 rollback target，因此该 turn 的 User message 可以回退。

1. 点击 Rollback 并确认。
2. Pi-Ark 移除该 user turn 及其后续 assistant/tool 输出。
3. 原 user message 回到 composer。
4. Composer 上方显示 Restore message。

点击 Restore message 会恢复原分支。编辑并发送替代 message 后，Restore message 消失。Rollback 不修改 Workspace 中的项目文件。

### Copy 与链接

Assistant text 的 Info 信息栏和展开后的 tool item 可以复制 `pi-ark://` message link。页面不提供绝对浏览器 message URL 的复制按钮。已完成的 assistant text 可以 Copy Markdown。复制成功后，按钮会短暂显示完成状态。

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

Hide reasoning 控制所有 Workspace 和 Session 的 reasoning 显示。开启后，conversation 不显示 Reasoning 折叠项和内容；Session history 与模型使用的上下文继续保留原始 reasoning。该开关会立即保存，刷新页面后继续生效。

### Global → Provider and model

1. 在 Manage Provider 中选择需要认证或断开的 Provider。模型行右侧的星标继续决定新 Session 的 default。
2. 通过 API key 或 subscription account 完成认证。
3. 在 Models shown in Pi-Ark 中勾选需要出现在模型菜单中的模型。列表按 Provider 分组，并支持搜索。
4. 点击模型行右侧的星标，将已勾选模型指定为新 Session 的 default。选择尚未勾选的模型作为 default 时，Pi-Ark 会同时勾选该模型。
5. 选择 default model 支持的 Default thinking level。

模型 checkbox、default 和 Default thinking level 在选择后立即保存。至少需要保留一个已勾选模型，default 必须属于已勾选模型。已有 Session 会继续恢复它记录的当前模型；如果该模型后来取消勾选，composer 仍显示当前的 `provider/model` reference，模型菜单显示当前已勾选的模型。API key 输入是 write-only；输入后使用该区域内的 Save API key 或 Cancel。浏览器接收 credential 状态与来源，credential 内容保存在服务端。

使用保存 credential 的 Provider 会显示 Disconnect。确认后，Pi-Ark 删除 `auth.json` 中该 Provider 的 credential。环境变量或 `models.json` 提供的认证继续由对应配置管理；Disconnect 的显示条件是 credential source 为 stored。断开后，Pi-Ark 保留仍可用的已勾选模型；如果没有剩余的已勾选模型，Pi-Ark 选择第一个仍可用模型作为模型清单和 default。

支持 subscription OAuth 的 Provider 会显示 Use subscription account。登录区可能显示授权链接、device code、文本输入、选择项或进度。Device code 可以使用旁边的 Copy 按钮复制。OpenAI 的 Sign in with ChatGPT 会自动使用当前 Pi-Ark 安装实例的 UUID，用户不需要输入该标识。同一个 Provider 重新开始登录时，Pi-Ark 会取消此前仍在等待的登录；页面刷新后可以直接重新开始。

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

移动端通过顶部菜单按钮打开 drawer sidebar。drawer 打开后，遮罩覆盖页面 header、composer 和 drawer 之外的其他应用内容；点击遮罩可以关闭 drawer。Chat 主列限制在屏幕宽度内，状态栏、conversation、sticky User row、Running 和 composer 不会向屏幕右侧溢出。

## Service 管理与 release 更新

```bash
pi-ark-dev status
pi-ark-dev logs
pi-ark-dev restart
pi-ark-dev update
pi-ark-dev rollback
```

`status` 显示 `pi-ark-dev.service` 状态，`logs` 持续显示该 service journal，`restart` 重启该 service。`update` 安装 GitHub latest release，`rollback` 恢复 previous release。管理备用实例时，将 command name 替换为 `pi-ark-backup`。

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

在 Settings → Global → Provider and model 中输入 API key，或为支持 subscription 的 Provider 完成 subscription login。认证完成后，在模型清单中勾选需要使用的模型并指定 default。

### Session 长时间显示 Loading conversation

Loading conversation 等待首个 WebSocket snapshot。检查浏览器到 `/ws/agent/...` 的连接、服务日志和 Session JSONL 的读取权限。

### Terminal 显示 Disconnected

检查 `/ws/terminal/...` 连接、node-pty 安装状态和服务账号的 shell 权限。

### System prompt preview 未更新

确认编辑的是页面显示的 `PI_ARK_AGENT_DIR` 文件路径，然后点击 Refresh。已经打开的 agent runtime 需要重新打开，才能使用新的 Workspace append 和 tools。
