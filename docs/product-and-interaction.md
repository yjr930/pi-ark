# Pi-Ark 功能与交互设计

## 产品定位

Pi-Ark 是面向个人或受控团队环境的 pi coding agent Web UI。服务端维护允许访问的 Workspace registry，浏览器在一个界面中完成 Agent 对话、文件阅读、命令行操作和配置管理。

每个 Session 固定归属于一个 Workspace。Agent tools、Files 和 Terminal 都以该 Workspace 的绝对目录为工作范围。

## 设计原则

- Workspace 是文件、Session 和 Workspace settings 的组织边界。
- Provider 凭证、默认 model 和服务外观属于 Global scope。
- Session 可以覆盖当前对话使用的 model 和 thinking level，同时保留 Global default。
- 破坏性操作使用确认对话框，并明确说明将保留或删除的数据。
- 长内容和工具执行过程逐层折叠，最终回答与重要状态保持可见。
- URL 保存当前页面、Workspace、Session 和目标 message，使浏览器刷新和分享链接可以恢复位置。
- 同一个 hostname 可以通过不同的 base path 提供多个实例；每个实例拥有独立的 Global settings、provider credentials 和登录状态。
- 多个实例可以共享 Workspace `.pi-ark` state；用户在同一时刻从一个实例操作指定的 Session。
- 所有列表、选择器、对话框和确认操作使用 Pi-Ark 组件，并保持一致的紧凑尺寸。

## 信息架构

登录后的应用由侧栏和主内容区组成。

侧栏包含以下区域：

1. Workspaces：选择、添加、重命名和关闭 Workspace。
2. 页面导航：Agent、Files、Terminal 和 Settings。
3. Sessions：新建 Session、打开内部链接、显示归档 Session、管理 Session group 和选择 Session。

主内容区根据当前页面展示对应功能。URL query 保存页面与选择状态；Session 和 message 也可以使用 `pi-ark://` 内部链接定位。

## Workspace

### 添加 Workspace

用户通过 Workspaces 标题旁的加号打开 Add workspace 对话框。目录必须是服务端已经存在、服务账号可以访问的绝对目录。目录输入会请求服务端建议，并允许用户设置显示名称。

添加成功后，Pi-Ark 将 Workspace 写入 Global registry，创建 `<workspace>/.pi-ark/` 状态目录，并切换到新 Workspace。

### 重命名与关闭

Rename 只修改侧栏显示名称。Workspace ID 和目录路径保持不变。

Close 从 Global registry 中取消注册。确认对话框明确显示 Workspace 名称和路径；项目文件、Workspace settings、附件和 Session 继续保留在服务器目录中。

### 空 Workspace 状态

Registry 为空时，主内容区显示 No open workspace，并提供 Add workspace 操作。Settings 的 Global 页面仍然可用。

## Session 管理

### Session 列表

Session 标题优先使用用户设置的名称，其次使用首条 user message。列表显示最近修改日期；置顶 Session 额外显示 Pin 图标。

每个 Session 提供以下操作：

- Rename：修改 Session 标题。
- Copy session link：复制 `pi-ark://` 内部链接。
- Manage groups：将 Session 同时分配到多个 group。
- Pin 或 Unpin：调整活跃 Session 的置顶状态。
- Archive 或 Restore：在活跃区域和 Archived 区域之间移动 Session。
- Delete：确认后删除 pi JSONL、Session metadata 和对应附件目录。

### Session group

用户可以创建、重命名和删除 group。一个 Session 可以出现在多个 group 中；未分配 group 的 Session 显示在 Ungrouped。删除 group 会移除 group 本身及 Session 的对应关联，不会删除 Session。

### 新建与选择

新建 Session 后，应用切换到 Agent 页面并打开新 Session。切换 Workspace 时，应用优先恢复 URL 指定的 Session，其次选择第一个未归档 Session。

## Agent conversation

### 加载状态

WebSocket 建立后，页面继续显示 Loading conversation。首个完整 snapshot 到达前，欢迎内容和 composer 保持隐藏，Session 相关的 header controls 保持 disabled。进度条采用 indeterminate 样式，因为服务端不提供百分比。

首个 snapshot 是 Session 加载完成的判定依据。切换 Session 时，旧 WebSocket 的后续事件不会更新新 Session。

### 空 Session 与运行状态

没有 message 的 Session 显示欢迎内容和 composer。发送 message 后，状态栏在连接、加载、工作、运行工具、就绪和连接错误之间变化。

正在执行的 turn 保持展开，便于用户观察中间 commentary 和工具活动。已完成并包含工具活动的 turn 将中间过程折叠为带用时和工具消息数量的 run collapse，最终 assistant response 保持展开。

已经停止运行但缺少 final assistant response 的历史 turn 仍将工具过程放入 run collapse，并在其后显示 Response interrupted warning。该 warning 表示 Pi 在产生最终回答前停止。

### 工具展示

Run collapse 展开后，reasoning、tool call 和 tool result 都可以继续单独展开；tool call 和 tool result 使用默认关闭的独立折叠框。

- Tool call summary 显示工具名称和 Call 状态，展开后显示格式化 arguments。
- Tool result summary 显示工具名称和 Result 状态，展开后显示文字或图片结果。
- 错误结果显示 Failed 状态和错误颜色。
- read、bash、write、edit 和后续自定义 tool result 使用相同的容器结构。

Message permalink 指向工具 message 时，外层 run collapse 自动展开，内层工具框继续保持关闭，由用户决定是否查看长结果。

### Message 标识与链接

每条 snapshot message 按当前 projection 顺序编号。Message header 可以复制浏览器 URL 或 `pi-ark://` 内部 message link。浏览器 URL 打开后会定位并高亮目标 message；内部链接可以通过侧栏的 Open Pi-Ark session link 对话框打开。

### Composer

Composer 的最大宽度固定为 Compact 宽度。Compact、Wide 和 Full 只改变 conversation message 区域的宽度。

输入框会随内容增长，最多显示十行，之后使用内部滚动。Enter 发送，Shift+Enter 换行；输入法正在组合文字时，Enter 交给输入法处理。

Composer 提供当前 Session 的 Model 和 Thinking 选择器。Model 列表来自当前可用凭证，Thinking 选项来自所选 model 的 pi capability。选择结果只影响当前 Session。

### Queue

Session 正在运行时，新 message 进入 queue。Queue 区分 Steering 和 Follow-up，显示各项文本摘要；用户可以在相同模式中调整顺序，也可以切换消息模式。Global settings 决定每种 queue 的默认投递方式。

### 附件与图片

每条 message 最多包含 8 个附件，单个附件最大 10 MB，总大小最大 20 MB。附件按钮支持普通文件和图片；剪贴板中的图片会进入附件队列，普通文字粘贴保持浏览器原生行为。

支持预览的图片格式包括 PNG、JPEG、GIF 和 WebP。发送前显示缩略图和删除操作；发送后的图片可以打开 lightbox。

### Assistant response actions

已完成的 assistant response footer 显示 model、context 使用量、context window、input token 和 output token，并提供以下操作：

- Copy Markdown：复制 assistant response 的文字 Markdown。
- Fork session：从该 response 对应的 session entry 创建新分支，并要求输入新 Session 名称。

### Rollback 与 Restore

Rollback 按钮显示在当前分支最后一条可回退的 user message 上。确认后，Pi-Ark 将当前分支移动到该 user turn 之前，将 user message 文本放回 composer，并显示 Restore message。

Rollback 只改变 conversation branch，不修改 Workspace 文件。用户可以恢复原分支，也可以编辑 composer 后发送替代 message；发送新 message 后，Restore message 消失。

### Session information

Header 的 Session information 面板显示创建时间、更新时间、消息数量、context token、context window、context 使用百分比、input token 总量、output token 总量和费用。

## Files

Files 页面的目录 breadcrumb 横跨文件列表和阅读区域，长目录路径可以使用整个页面宽度。breadcrumb 下方的左侧区域显示目录内容，右侧区域显示选中文件，并在阅读区域顶部单独显示文件路径。目录列表顶部的 Up one level 返回父目录；目录导航始终限制在 Workspace 内。

桌面端可以拖动文件列表与阅读区域之间的 separator，调整后的文件列表宽度保存在浏览器 localStorage。移动端继续使用上下堆叠布局。每个文件和目录右侧的 action menu 可以复制服务器绝对路径或 Workspace-relative path；每个文件的 menu 还提供 Download。

Markdown 文件使用与 conversation 相同的安全 Markdown renderer，并支持相对图片路径。PNG、JPEG、GIF 和 WebP 文件在阅读区域内按可用空间预览，其他文本文件使用代码视图。选中文件的 header 始终提供 Download；binary file 或超过 Workspace 预览上限的文件显示下载状态，不读取文件内容。Workspace settings 可以控制 dotfile 显示和最大预览大小；预览大小默认是 10 MB，可以设置为 1–100 MB。Pi-Ark 自身的 `.pi-ark` 状态目录始终不进入文件列表。

## Terminal

Terminal 页面使用 xterm.js，并在 Workspace 目录中启动 PTY。Header 显示连接状态和 Fit terminal 操作；容器尺寸变化时，终端自动调整行列数。

Terminal 命令使用 Pi-Ark 服务账号的系统权限。Workspace 是启动目录，并不构成操作系统 sandbox。

## Settings

### Global

Global configuration 对所有 Workspace 生效，并使用以下主题分类：

- Interface：Appearance，包含 Ark Dark、Graphite、Midnight、Paper 和 Snow。
- AI runtime：Provider and model，包含 provider、default model、model-specific thinking level、write-only API key 和可用的 subscription login。
- Installation and maintenance：Pi-Ark version、bundled pi core version、install mode、release channel、latest/previous release、install/data/package paths、更新、回退，以及 status/logs/restart 等 service commands。
- Agent instructions and behavior：System prompt 和 Agent defaults，包含可选 replacement/append 文件路径、effective prompt preview、Steering、Follow-up、automatic compaction 和 automatic retry。
- Account and security：Sign out。

Settings 默认在选择、切换或输入完成后立即保存，页面底部不提供统一 Save 操作。Theme 在选择时立即预览并写入服务配置；provider、model、thinking 和 Agent defaults 在选择后保存。API key 与 Workspace system prompt append 需要用户确认，因此 Save 和 Cancel 显示在各自的 section 内。API key 和 OAuth credential 由 pi 保存，浏览器不会读取已经保存的 credential 内容。需要安装实例标识的 subscription login 由 Server 自动生成并复用 Global device ID，页面不要求用户输入该值。同一个 Provider 再次启动 subscription login 时，Server 会取消此前仍在等待的登录，避免页面刷新后遗留的 flow 阻塞新登录。

Update Pi-Ark 安装完整的 release artifact，其中包含经过同一版本检查的 Pi-Ark、pi-coding-agent 和 pi-ai。更新过程保留 Global data 与 Workspace data，将 `current` symlink 切换到新 release，并在延迟重启前保留上一 release。Roll back 将 `current` 和 `previous` 对调。Development checkout 和带 `dev` prerelease 的本机安装会显示 development 状态；development build 不显示 stable update 操作。

### Workspace

Workspace configuration 包含以下区域：

- System prompt append：在 pi 加载 Global system prompt 资源后追加 Workspace 内容。
- Agent tools：选择 read、bash、edit 和 write；至少保留一个 tool。
- File browser：控制 hidden files 的显示，以及 Files 文本、Markdown 和图片的最大预览大小。

Agent tools 在 Pi-Ark 新建或重新打开 Session 时进入 agent runtime。File browser 设置保存后立即用于后续 Files 请求。

## 桌面与移动布局

桌面侧栏可以折叠，并可以通过 separator 拖动到 220 至 460 px。侧栏折叠状态、侧栏宽度、Files 文件列表宽度、Workspaces 展开状态、conversation width 和最近应用的 theme 存放在浏览器 localStorage；保存后的 Global theme 仍是服务端配置的默认值。

移动端使用 drawer sidebar 和顶部 mobile bar。drawer 打开时，scrim 覆盖 drawer 之外的完整应用内容，其中包括页面 header、composer 和其他浮动控件；drawer 位于 scrim 上方。点击页面入口或 Session 后，drawer 自动关闭。Composer、对话框和 Settings actions 使用适合窄屏的布局。

## 对话框与反馈

普通对话框共享紧凑的 card、header、field 和 action 样式。Delete 等会删除数据的操作使用 danger 样式；Rollback 使用 neutral secondary 样式。

异步操作通过页面 status、Settings notice、dialog error 或全局错误提示反馈。Copy URL、Copy Markdown、Copy internal link 和 device code copy 使用短暂的 Copied 状态确认操作完成。
