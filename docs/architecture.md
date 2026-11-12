# Pi-Ark 程序实现架构

## 系统目标

Pi-Ark 是一个常驻 HTTPS 服务。浏览器通过该服务管理 Workspace、运行 pi coding agent Session、阅读文件和使用 PTY Terminal。

系统保留 pi 的原生 session tree 和 SDK runtime，同时将 Workspace registry、Session metadata、附件和 UI settings 放在职责明确的 Pi-Ark data directory 中。

## 总体结构

```text
Browser
  ├─ React application
  │   ├─ Agent conversation and composer
  │   ├─ Workspace and Session management
  │   ├─ Files and Markdown reader
  │   ├─ xterm.js Terminal
  │   └─ Global and Workspace Settings
  │
  └─ HTTPS / WebSocket
      │
Fastify server
  ├─ AuthService
  ├─ WorkspaceService
  ├─ AgentService
  │   └─ @earendil-works/pi-coding-agent
  ├─ SkillService and McpService
  ├─ SettingsService and AuthFlowService
  ├─ Release manager
  ├─ Session metadata store
  ├─ Attachment service
  ├─ File and image service
  ├─ node-pty Terminal
  └─ Static web asset server
      │
      ├─ PI_ARK_HOME/config.json
      ├─ PI_ARK_AGENT_DIR/
      └─ <workspace>/.pi-ark/
```

## Monorepo 结构

```text
apps/server/        Fastify、pi SDK、文件和 PTY 服务
apps/web/           React、Vite、Markdown 和 xterm.js UI
scripts/            初始化、跨平台安装、后台管理、release 构建和行为检查
docs/               产品、架构、使用和集成文档
```

根 `package.json` 使用 npm workspaces 管理 `apps/*`。正式构建先生成 Web assets，再编译 Server；Server 从 `apps/web/dist` 提供静态文件。

## 服务启动

`apps/server/src/index.ts` 执行以下启动顺序：

1. 根据 `PI_ARK_HOME` 和 `PI_ARK_AGENT_DIR` 初始化 Pi-Ark 专用的 pi agent data directory。
2. 将 `PI_CODING_AGENT_DIR` 指向该专用目录，使 pi SDK 使用相同的 settings、credential 和 resource files。
3. 读取 Global config 与 TLS key/certificate。
4. 创建 HTTPS Fastify service；HTTP request body 上限为 1 MB，WebSocket payload 上限为 28 MB。
5. 创建 Auth、Workspace、Terminal、Settings、Pi-Ark release、OAuth flow、Agent、Skills 和 MCP services。
6. 注册 HTTP routes、Agent WebSocket 和 Terminal WebSocket。
7. 注册静态 Web asset fallback。
8. 监听配置的 HTTPS 地址。

收到 SIGINT 或 SIGTERM 时，Server 先释放全部 Terminal 资源，再释放 Agent runtime，最后关闭 Fastify。Fastify 的 onClose hook 同样执行 Terminal 的资源释放。

## Server 模块

| 模块 | 文件 | 职责 |
|---|---|---|
| Server composition | `apps/server/src/index.ts` | 启动、认证 hook、HTTP/WebSocket routes、静态资源和 shutdown |
| Global config | `apps/server/src/config.ts` | 配置解析、data directory、共享 preferences 和串行原子写入 |
| Authentication | `apps/server/src/auth.ts` | scrypt password、持久化 session token 和 cookie |
| Workspace and Files | `apps/server/src/workspaces.ts` | Workspace registry、目录建议、安全路径、文本与图片预览和文件下载 |
| Agent runtime | `apps/server/src/agents.ts` | pi Session 生命周期、snapshot、queue、fork、rollback、attachments、自带工具注册和广播 |
| Agent resources | `apps/server/src/resource-loader.ts` | 三个 skill 目录、`skillsOverride`、MCP 与 codemode extension 和 Session resource loader |
| Skills | `apps/server/src/skills.ts` | skill 目录扫描、同名冲突、停用过滤、选择保存和空闲 Session 重载 |
| MCP | `apps/server/src/mcp.ts` | `mcp.json` 初始化、server 列表、启用状态、浏览器运行时状态与安装 |
| Internal links | `apps/server/src/internal-links.ts` | Web 与 Server 共用的 Workspace、Session 和 Message 内部链接解析与生成 |
| Session display | `apps/server/src/session-display.ts` | 完整活动分支的 display projection、短 Message ID、Compact 统计和旧数字目标的定位 |
| Compact statistics | `apps/server/src/compaction-stats.ts` | 按压缩时的 projection 估算上下文组成，并关联压缩耗时 |
| Session reader | `apps/server/src/session-reader.ts` | Workspace 摘要、Session 分页、Message 定位、前后文和长内容续读 |
| Pi-Ark link tool | `apps/server/src/agent-tools/read-pi-ark-link.ts` | `read_pi_ark_link` 的参数、输出 schema、说明和执行入口 |
| Subagent tool | `apps/server/src/agent-tools/subagent.ts` | 任务委派的参数与进度回调 |
| Web fetch tool | `apps/server/src/agent-tools/webfetch.ts` | `webfetch` 的参数、HTML 转 Markdown、响应体上限与错误处理 |
| Subagent runtime | `apps/server/src/subagents.ts`、`subagent-types.ts` | 子 Session 的创建、调度、停止与结果汇总 |
| Subagent store | `apps/server/src/subagent-store.ts` | 委派记录的保存、关系查询与中断恢复 |
| Attachments | `apps/server/src/attachments.ts` | 限额检查、文件名清理、保存和 image content 转换 |
| Session metadata | `apps/server/src/session-metadata.ts` | Pin、Archive、group 和串行原子写入 |
| Workspace Notebook | `apps/server/src/workspace-notebook.ts` | Workspace 临时笔记的读取与串行原子写入 |
| Global settings | `apps/server/src/settings.ts` | Provider、model、thinking、queue、compaction、retry 和 credential login |
| OAuth flow | `apps/server/src/auth-flows.ts` | Subscription login 的事件、prompt、answer 和 cancel 状态 |
| Pi-Ark release | `apps/server/src/pi-core.ts` | Pi-Ark 与 bundled pi core 版本信息、GitHub Releases 查询、完整 release 更新、回退和延迟重启 |
| Terminal | `apps/server/src/terminal.ts` | 按 Workspace 管理多 Tab 的 PTY、内存输出历史、订阅、增量重连与资源释放 |
| Terminal shells | `apps/server/src/terminal-shells.ts` | Terminal 配置归一化、可执行程序探测、跨平台 shell 解析与 UTF-8 环境 |

## Web 模块

| 模块 | 文件 | 职责 |
|---|---|---|
| Application shell | `apps/web/src/App.tsx` | Auth 状态、Workspace/Session 选择、页面导航、URL 和响应式侧栏 |
| Agent page | `apps/web/src/components/Chat.tsx` | WebSocket snapshot、message renderer、composer、queue、fork 和 rollback |
| Subagent list | `apps/web/src/components/SubagentRun.tsx`、`apps/web/src/subagent-view.ts` | 按子 Session 合并最新任务、状态栏数量、活动列表、Completed 分组与父子导航 |
| Session browser cache | `apps/web/src/session-cache.ts` | IndexedDB 中最近 50 个 Session 的 snapshot、UI state 与文件路径确认结果 LRU cache，并提供清理入口 |
| Session status projection | `apps/web/src/session-status.ts` | 合并 runtime revision、计算 unread output 和记录当前浏览器的查看状态 |
| Session selection | `apps/web/src/session-selection.ts` | 会话列表刷新后决定保留还是替换当前 Session；尚未写入文件的 Session 依靠 runtime status 识别 |
| Conversation segmentation | `apps/web/src/conversation.ts` | Turn 分段、tool run collapse 和 interrupted warning |
| Workspace list | `apps/web/src/components/WorkspaceList.tsx` | 选择、重命名和关闭 Workspace |
| Session list | `apps/web/src/components/SessionList.tsx` | 单行 Session、更新时间 tooltip、Notebook 入口、groups 和 Archived 区域 |
| Notebook | `apps/web/src/components/Notebook.tsx` | Workspace 笔记加载、debounce 自动保存和保存状态 |
| Files | `apps/web/src/components/Files.tsx` | 全宽目录导航、可调整的文件列表、path copy、文本阅读和 Markdown image path |
| Markdown | `apps/web/src/components/Markdown.tsx` | marked、DOMPurify、链接和图片展示，以及全局单次换行的显示设置 |
| Terminal | `apps/web/src/components/Terminal.tsx` | Workspace 的 Tab 列表、创建与关闭、选中状态、连接状态及工具栏 |
| Terminal client | `apps/web/src/terminal-client.ts` | 每个 Tab 的 xterm.js、FitAddon、WebSocket、UTF-16 offset 重连、剪贴板与选区复制 |
| Terminal appearance | `apps/web/src/terminal-preferences.ts` | 浏览器字体偏好、系统等宽字体列表、历史默认字体迁移、localStorage 与偏好变更事件 |
| Terminal tooltip | `apps/web/src/components/TerminalTooltip.tsx` | Terminal 的 hover、focus 与触屏详情，portal 定位与交互式连接说明 |
| Terminal settings | `apps/web/src/components/TerminalSettings.tsx` | 按需加载 Server shell 配置、草稿与保存队列、Refresh 草稿保留及浏览器字体编辑 |
| Settings | `apps/web/src/components/Settings.tsx` | 按功能类别展示设置，保留页面状态，并按需加载 prompt preview、Terminal 配置与 release 信息 |
| Skills settings | `apps/web/src/components/SkillsSettings.tsx` | 三段 skill 列表、Workspace 选择器、启用复选框、诊断和 Refresh |
| MCP settings | `apps/web/src/components/McpSettings.tsx` | server 列表、启用开关、连接状态、诊断、浏览器运行时和安装进度 |
| API client | `apps/web/src/api.ts` | HTTP request、error mapping 和 WebSocket URL |
| Permalinks | `apps/web/src/permalinks.ts` | Browser URL 与 `pi-ark://` link 的生成和解析 |
| Theme | `apps/web/src/theme.ts` | Theme metadata、应用和本地初始化 |

Files、Terminal 和 Settings 使用 React lazy loading。Chat 保持在主 bundle 中，Session 切换时可以立即建立 WebSocket。

App 从 `/api/ui` 读取 `markdownLineBreaks`，并通过 React Context 将该设置传给共享的 Markdown renderer。Renderer 调用 `marked.parse(..., { breaks: markdownLineBreaks })`，使 conversations 与 Markdown files 使用相同的单次换行显示规则。该设置默认开启，控制 Markdown 的显示；原始文本、复制的 Markdown、Session JSONL 和 model context 保持原内容。

## Authentication

Password 使用 scrypt 保存为 `scrypt$salt$digest`。登录成功后，AuthService 生成随机 token，将 token 的 SHA-256 哈希与 24 小时后的 expiry 写入 `PI_ARK_HOME/auth-sessions.json`。文件使用 `0o600`，并通过同目录临时文件与 rename 原子替换。Server 启动时在注册 routes 前读取该文件，因此服务重启后浏览器已有 cookie 继续有效。

Cookie 属性如下：

- `HttpOnly`
- `Secure`
- `SameSite=Strict`
- Path `/`
- Max-Age 24 小时

登录 session 使用固定的 24 小时有效期，与 cookie 的 Max-Age 一致。Logout 删除当前 token 并立即持久化。文件同时保存当前 username 与 password hash 的指纹；密码或用户名变化后，启动时丢弃全部旧 session。文件损坏或版本不匹配时，AuthService 以空 session 集合启动并重写文件。

Fastify `onRequest` hook 保护所有 `/api/` 和 `/ws/` 路径；health 和 login routes 保持公开。WebSocket upgrade 使用相同的 cookie 认证。

## 文件链接的异步增强

`Markdown` 在现有 marked 与 DOMPurify 渲染完成后，通过 `file-link-dom.ts` 为正文和 inline code 增加文件链接。`FileLinksContext` 提供当前 Workspace，Files 的 Markdown 预览通过 `fileBasePath` 提供文件所在目录。该增强保持消息原文、复制内容与提示词资源的现有行为。

IntersectionObserver 选取视区及附近 200 px 内的内容，内容稳定约 1.5 秒后进入共享空闲任务队列。每次扫描处理有限的 DOM 节点或文本字符；超长 Text 节点使用一次文本快照和局部 MutationObserver 确认变化。网络等待期间暂停该扫描，结果到达后分片写入链接。组件内容、Workspace 或基目录变化时取消旧任务，随后对新内容执行识别。

`file-links.ts` 的共享请求队列按 Workspace、基目录与输入路径去重，并使用有限的内存缓存。具体的处理参数如下：

| 参数 | 当前值 |
|---|---|
| 每次空闲队列调度的工作时长 | 约 4 ms |
| 每次调度的处理步骤 | 最多 16 个 |
| 单个文本扫描步骤的字符数 | 最多 2048 个 |
| 每批路径确认的路径数 | 最多 64 条 |
| 浏览器的并发确认请求 | 最多 2 个 |
| 已确认路径的缓存时间 | 60 秒 |
| 缺失路径或请求失败的缓存时间 | 15 秒 |
| 路径确认缓存的容量 | 最多 2048 条 |
| 持久化路径确认的有效期 | 24 小时 |
| 持久化路径确认的容量 | 最多 2048 条 |

已确认的路径结果随 Session cache 写入同一个 IndexedDB 数据库的 `fileLinks` store，并在页面初始化时、首个确认请求前装载到内存缓存。已保存的结果直接生成链接，不再向 Server 确认；装载后的使用会更新 LRU 时间，24 小时有效期从最后一次真实确认开始计算，过期的结果重新进入确认队列。缺失路径与请求失败的结果不保存。Settings → Interface 的 Clear browser cache 同时清空这份结果。

标准 Markdown 的本地 href 解码一次后送入同一确认队列；正文中的路径保持其字面值。标准本地链接在后台确认前点击时，浏览器先拦截导航，再异步确认并打开 Files。文件链接使用带 `page=files`、`workspace`、`path` 与 `kind` 的应用 URL，App 处理普通点击，修饰键沿用浏览器的新标签页操作。Files 按目标加载目录与文件，刷新时从 URL 恢复该目标。从 Agent 打开文件时，App 通过 `pushState` 新增 Files 的历史记录，并将原会话的阅读位置保存在来源记录的 `history.state.piArkAgentReturn` 中；Files 内的浏览继续使用 `replaceState`。`popstate` 根据 URL 恢复页面、Workspace、Session、message 与历史分支，Chat 在取得 snapshot 后恢复阅读位置，并沿用已有的草稿与 disclosure 缓存。浏览器的前进操作恢复当前的 Files 目标。

`POST /api/workspaces/:workspaceId/file-links/resolve` 接收 `{ paths: string[], basePath?: string }`，返回 `{ links: Array<{ input, path, type }> }`。`type` 为 `file` 或 `directory`，`path` 使用 canonical Workspace 相对路径。每次请求最多包含 64 条路径，每条最多 2048 字符；Server 使用最多 4 个并发的异步文件系统任务，通过 `WorkspaceService.safePath` 与 metadata 确认目标，沿用 realpath、Workspace 范围及 `.pi-ark` 的访问规则。

## Workspace 与文件边界

Global config 中的 Workspace registry 是浏览器可以访问的目录清单。Add workspace 执行以下检查：

- 输入是绝对路径。
- `realpath` 可以解析。
- 路径是目录。
- 同一个真实目录尚未注册。

文件读取先将 Workspace path 和请求 path 解析为 `realpath`，再通过 `path.relative` 与本机路径分隔符检查结果仍位于 Workspace 内。包含 `.pi-ark` path segment 的请求会被拒绝；目录列表也始终过滤该目录，Windows 与 macOS 对该名称采用大小写归一化。

打开文件后，Linux 使用 `/proc/self/fd/<fd>` 核对实际读取对象的位置。macOS 与 Windows 对解析后的路径再次执行 `realpath` 和 `lstat`，并将 `dev` 与 `ino` 同已打开 file descriptor 的身份信息核对；预览、图片和下载都从该 descriptor 读取。

文本、Markdown 和图片共用 Workspace 的 `files.maxPreviewSizeMb` 预览上限。默认值是 10 MB，保存范围是 1–100 MB；包含 NUL byte 的 binary file 不进入文本预览。PNG、JPEG、GIF 和 WebP 可以作为选中文件或 Markdown image 预览。下载 endpoint 使用 stream 返回原始文件，不受预览大小和文件类型限制。

Directory suggestions 只返回服务账号可以读取的目录和直接子目录，每次最多返回 100 个结果。

## Terminal runtime

### Server 的 Tab 生命周期

`TerminalService` 按 Workspace ID 保存 Tab registry，每个 Tab 包含独立的 node-pty 进程、`TerminalInfo`、输出分块与 WebSocket subscribers。创建时校验 Workspace，以对应目录作为 cwd，并使用当时保存的 Global Terminal 设置启动程序。标题按 Workspace 的创建顺序显示为 `Terminal 1` 等可读名称。

PTY 的每次输出追加一个分块，并记录该分块起点和输出后的 UTF-16 总长度。Server 在当前进程的运行生命周期内保留完整的输出历史，重连时根据 offset 查找并拼接所需的后续内容。WebSocket 断开时注销订阅，PTY 继续运行和记录输出。自然退出将状态更新为 `exited` 并保存 exit code，Tab 与历史继续保留到显式关闭。

显式关闭 Tab 时，Server 从 registry 移除该 Tab，广播 `closed`，注销订阅，关闭 sockets，并释放仍在运行的 PTY 和输出分块。Workspace 关闭成功后清理该 Workspace 的所有 Terminal；Server shutdown 清理全部 Terminal。Tab 的进程和历史使用 Server 的内存保存，生命周期随当前 Server 进程结束。

### 浏览器的 Terminal 页面缓存

`App.tsx` 按已访问的 Workspace 保持独立的 Terminal 容器，并为每个容器使用独立的 Suspense。离开 Terminal 或切换 Workspace 时，通过 `hidden` 隐藏已挂载的容器。每个 Tab 的 xterm DOM 和 WebSocket 保持挂载，切回后直接显示保留状态（输出、阅读位置与选区）。关闭 Tab 或 Workspace 时卸载对应组件并释放浏览器资源。

首次打开 Workspace 的 Terminal 时，页面读取 Server 的 Tab 列表；列表为空时自动创建首个 Tab。关闭最后一个 Tab 后显示空状态，并提供 `New terminal` 和 `Refresh tabs`。当前 Terminal 页面激活时，在窗口获得焦点、文档恢复可见和每 10 秒时同步 Tab 列表，处理其他浏览器创建或关闭的 Tab。

同一个 xterm 发生连接中断时，`TerminalClient` 以已接收的 UTF-16 offset 重新连接，并对返回数据按 offset 去重；自动重连使用从 500 ms 增长到 10 秒的等待时间，并提供 Retry。浏览器刷新后，从 Server 重新取得 Tab 列表，为各 Tab 创建 xterm，并从 offset `0` 回放历史。选中 Tab 的标识保存在浏览器 localStorage 中。

Terminal 的 Tab、加号与 Terminal details（省略号图标）在同一栏中排列；浏览器将 Server 的默认标题 `Terminal 1` 显示为简短的 `Tab 1`，Tab 的常驻内容为名称与关闭按钮。`TerminalTooltip` 将辅助信息通过 portal 渲染到 document body，并根据 viewport 调整位置；连接详情同时支持 hover、focus 与触屏点击，保留 Retry 的键盘访问。Escape、外部点击、再次点击指示器或切换 Tab 与页面时关闭详情。操作反馈绝对定位在 Terminal 内容区域的右上角；成功反馈在 2.8 秒后清除，错误反馈保留关闭按钮。悬浮内容保持 Terminal 的布局尺寸。

Terminal 的粘贴使用系统、浏览器和 xterm 的默认行为。工具栏的 Paste 通过 `navigator.clipboard.readText()` 读取文字，并调用 xterm 的 `paste()`；工具栏的 Copy 与复制快捷键（Ctrl+Shift+C 或 Cmd+C）使用当前选区，并通过 `navigator.clipboard.writeText()` 写入剪贴板。输入法组合文字期间，custom key handler 继续交由 xterm 处理按键。Fit 在当前可见 Tab 上计算尺寸，并将行列数通过 `resize` 同步到 Server。

## Agent runtime

### Runtime registry

AgentService 按 `workspaceId:sessionId` 缓存运行时 handle。Handle 包含以下状态：

- `AgentSession`
- 已连接的 WebSocket clients，以及每个 client 已加载的 display window 起点
- pi event unsubscribe function
- Pi-Ark queue metadata、queue revision 和 rebuild version
- 共享的 queue rebuild promise 与 rebuild 状态
- 当前活动 branch 的 display projection cache
- Sidebar 使用的 runtime state、status revision、completed update revision 和最后一次 error message

多个浏览器连接共享同一个 Session runtime。浏览器断开不会中止 Agent；重新连接会收到当前 snapshot。Session message/tree 变化时，AgentService 清除 display projection cache；后续 snapshot 重新构建 projection。

### Session 创建与恢复

新 Session 使用 `SessionManager.create(workspace.path, sessionDir)`。恢复使用 `SessionManager.open(jsonlPath, sessionDir)`。Workspace session directory 固定为 `<workspace>/.pi-ark/sessions/`。新 Session 在出现首条 user 或 assistant message 之前没有 JSONL 文件，因此不进入 Session 列表；Web 在该 Session 的首条 user message `message_end` 到达时重新读取 Session 列表，使新建的 Session 在发送消息后立即出现在侧栏。

创建 AgentSession 时，AgentService 加载以下输入：

- Workspace cwd。
- 统一启用的文件工具（`read`、`bash`、`edit` 和 `write`），以及父子 Session 自带的 `read_pi_ark_link` 与 `webfetch`；父 Session 还启用 `subagent`。
- Pi-Ark agent directory 中的 Global resources。
- Global system prompt append。
- 已有 SessionManager。
- `enabledModels` 解析出的 scoped models。

新 Session 使用已勾选模型中的 Global default；Global default 不在当前 scope 中时，使用 scope 中的第一个模型。恢复已有 Session 时，pi SDK 优先恢复 Session JSONL 记录的当前模型，scoped models 用于后续模型选择。

### Subagent

普通 Session 通过 `subagent` 工具委派任务。输入为 `tasks` 数组，每个任务包含 `title`、`task`、`expectedResult`，以及可选的 `sessionId` 和 `references`（`link`、`purpose` 和可选的 `leafEntryId`）。省略 `sessionId` 时创建子 Session，提供 `sessionId` 时继续当前父 Session 在当前 Workspace 中已有的子 Session。新建子 Session 时应当不写 `sessionId` 属性，`none`、`__new__` 这类占位值会被拒绝并返回提示。工具结果返回每个任务的 `sessionId`，供后续委派使用。一次委派支持 1–8 个任务，每个父 Session 最多同时执行 4 个任务，服务实例最多同时执行 8 个任务。

`SubagentService` 使用进程内 SDK 为每个任务创建独立的持久化 Session，并复用 `AgentService` 的 runtime registry。创建与恢复使用相同的进行中 Promise，网页打开子 Session 时复用同一个 runtime。子 Session 继承父 Session 当次委派的配置（模型、thinking level 和 Global system prompt append），并追加任务角色说明。子 Session 使用独立的消息上下文，Workspace 文件目录由父子 Session 共享。父子 Session 在新建和恢复时统一启用文件工具（`read`、`bash`、`edit` 和 `write`）以及 `read_pi_ark_link`；父 Session 还启用 `subagent`，子 Session 的后续委派由父 Session 组织。再次委派复用已有的 runtime 与上下文，并沿用子 Session 自身的配置；每轮委派创建独立 run，历史的来源与结果链接继续保留。异步打开 Session 之前预留执行 control，校验目标的父子归属与活动状态；同一子 Session 的新轮次在旧轮次的清理之后继续保留自己的 control。对于已有委派记录且尚待 SDK 写出首条 assistant message 的子 Session，网页按需创建对应的 runtime，后续任务执行复用该 runtime。

委派记录保存到 `<workspace>/.pi-ark/subagent-runs/<run-id>.json`，包括父子关系、配置快照、工具调用标识、状态、引用、结果 entry、结果摘录与本轮用量。任务的可选 `configuration` 保存再次委派时的 model、thinking level、tools 与 system prompt append；恢复时优先使用该任务的配置，历史记录回退到 run 的配置。任务的可选 `updatedAt` 在 queued、running、工具活动、完成消息、任务结束与中断恢复时更新；历史记录由 Web 依次使用 finishedAt、startedAt 与 run.createdAt 展示更新时间。记录按目标文件串行写入，使用临时文件与 rename 完成替换。相同父 Session 的相同 tool call 复用已有记录。子 Session 的消息继续使用原生 JSONL，并追加 `pi-ark.subagent-origin` custom entry。配置快照中的 `tools` 字段作为当次委派的记录保留；恢复时的文件工具由统一启用的工具列表提供。

状态包括 `queued`、`running`、`completed`、`failed`、`cancelled` 和 `interrupted`。浏览器断开后任务继续执行；父 Session 的 Stop 会停止本次仍在等待的子任务；子任务的 Stop 操作针对该任务。服务加载已有记录时，将遗留的 `queued` 与 `running` 改为 `interrupted`，用户可以再次委派任务。删除操作保留委派记录，并标记父或子 Session 已删除。

Server 自动附加父 Session 最近的 user message 作为来源，并保存引用的分支 entry。显式 Message 引用中的图片通过原始 image content 传入子 Session，相同来源 entry 的图片传递一次，每个任务最多传递 8 张图片与 20 MB 的图片内容。工具等待任务结束，并返回状态、结果摘录（最多 4096 bytes 或 200 行）、子 Session link、带历史分支参数的结果 Message link、用量与错误信息。完整正文继续通过 `read_pi_ark_link` 读取。

`subagent-state` 向父 Session 与同一父 Session 的所有已连接子 Session 发送关系与状态；snapshot 携带 `subagents`，其中包括 `runs`、可选的 `parentRuns`、可选的 `origin` 与 `managed`。`origin` 指向该子 Session 最近一次委派，`parentRuns` 为该子 Session 的父 Session 的委派记录。Web 按 `sessionId` 合并最新任务，将其用于数量与列表；上方展示 queued/running，底部的 Completed 分组展示其他结束状态。父会话的 runtime 状态复用 App 的 `sessionStatuses`。

子 Session 始终由父 Agent 提交任务。Server 按持久化 `origin` 对用户的交互式 prompt 返回 409，Web 始终隐藏该 Session 的 Composer；运行中的模型修改与会话回退继续返回 409。消息的原始 role 保留在 Session 中，Web 在子会话的角色显示层将 user 标为 `Parent Agent`，将 assistant 标为 `SubAgent`，并沿用原有的角色样式。SessionList 过滤带 `subagentOrigin` 的子 Session，完整的 Session 数据仍供内部链接与父会话标题导航使用。

### Pi-Ark link 读取工具

`AgentService` 接收当前 `WorkspaceService` registry，并在创建和恢复 AgentSession 时通过 `createAgentSession({ customTools })` 注册 `read_pi_ark_link`。显式 `tools` 列表在父子 Session 中均包含该名称，并统一启用文件工具（`read`、`bash`、`edit` 和 `write`）与 `webfetch`。Global effective system prompt preview 使用相同的文件工具和自带工具定义。工具提供 `description`、`promptSnippet` 和 `promptGuidelines`，引导 Agent 使用工具读取用户提供的内部链接。

`internal-links.ts` 是独立于浏览器环境的链接模块，Web 的 `permalinks.ts` 直接复用该模块。工具支持 `pi-ark://workspace/<workspace-id>`、其后的 `/session/<session-id>`，以及 `/message/<message-id>`。Web 的 Session link 对话框继续接受 Session 和 Message link。短 Message ID 与旧数字目标共用 `session-display.ts` 的定位函数；数字目标按完整活动分支的 display position 解析，返回值中的链接使用短 Message ID。

`SessionReader` 按 registry 取得 Workspace。目标 Session 已有 runtime 时，reader 读取该 runtime 的 SessionManager，以保留当前活动 leaf。其他目标使用 `SessionManager.findById()` 查找实际文件，再通过 `parseSessionEntries()` 和 `SessionManager.inMemory(cwd, undefined, entries)` 加载。旧格式的迁移在内存中完成。读取过程保持目标文件和运行状态，并且不会创建目标 AgentSession。工具采用与 Web 相同的完整 display projection，包含 compact 之前的消息及 summary。

参数和返回行为如下：

| 参数 | 行为 |
|---|---|
| `link` | Workspace、Session 或 Message 内部链接 |
| `context` | Message 目标前后的消息数量，默认为 0，范围为 0–20 |
| `start` | Workspace 的 Session 列表位置，或 Session 的 display message 位置，从 1 开始 |
| `limit` | Workspace 或 Session 的分页数量，默认为 20，范围为 1–100；Session 省略 `start` 时返回末尾一页 |
| `offset` | Message 正文的 UTF-16 字符位置，默认为 0；使用返回的 `nextContentOffset` 继续读取 |
| `leafEntryId` | 可选的历史分支 entry，也可以通过内部链接的同名 query 提供；使用 `getBranch(leafEntryId)` 构建 display projection |

成功结果以 JSON text 和符合 `outputSchema` 的 `structuredContent` 返回。结果包含 Workspace、Session、target、messages 或 Session 摘要、pagination 和 `truncated`。每条消息包含短 Message ID、source entry ID、当前 display position、内部链接、role、timestamp 和可用的 model 或 tool 信息。正文按顺序保留文本、reasoning、tool call arguments、tool result 和 summary；图片表示为 MIME type 占位说明。消息的 `contentOffset`、`totalContentCharacters` 和 `nextContentOffset` 支持完整续读。

单次序列化的结果最多为 48 KiB。Message 加前后文时优先为目标分配正文空间，结果仍按 display position 排列。部分消息提供 `nextContentOffset`；`pagination.nextStart` 指向后续条目，调用方使用 Session 或 Workspace link 继续分页。`INVALID_LINK`、`UNKNOWN_WORKSPACE`、`UNKNOWN_SESSION`、`MESSAGE_NOT_FOUND`、`INVALID_ARGUMENT`、`PAGE_OUT_OF_RANGE` 和 `CONTENT_OUT_OF_RANGE` 区分链接与读取错误。工具支持 AbortSignal，并声明读取性质的 annotations。

链接参数与工具参数中的 `leafEntryId` 需要一致。返回的 Session 信息包含所选的 `leafEntryId`，指定分支时返回的链接也携带该参数。`BRANCH_NOT_FOUND` 表示指定 entry 已不存在。历史读取保持当前活动 leaf。

### 网页抓取工具

`AgentService` 在创建和恢复 AgentSession 时通过 `createAgentSession({ customTools })` 注册 `webfetch`，父子 Session 都在 `tools` 列表中启用它。工具接收 `url`、`format` 和 `timeout` 参数，发起 HTTP 请求并跟随重定向。

- `format` 取 `markdown` 或 `raw`。HTML 响应在 `markdown` 下转换成 Markdown，脚本、样式、模板与 svg 内容在转换前移除；JSON、XML 与纯文本按原样返回。
- 响应体上限为 5 MiB，超出时截断并在结果末尾标注被截断。`details` 与 `structuredContent` 返回最终 URL、状态码、content type、字节数与 `truncated`。
- 默认超时 30 秒，最大 120 秒。工具信号与超时都会中断请求。
- 状态码不为 2xx 时抛出带状态码与正文片段的错误；非文本响应抛出 `Unsupported content type`；只接受 `http` 与 `https`。
- 文本编码读取 `content-type` 的 charset，无法解码时回退 UTF-8。
- 工具声明只读 annotations，允许并行执行。说明里要求需要 JavaScript 渲染、登录、点击或截图的页面改用浏览器工具。

### Snapshot

连接成功后，Server 立即发送 snapshot。Snapshot message 来源是当前活动 branch 的 display projection；每条持久化 message 附加短 Message ID 和 source entry ID，assistant message 还附加 model context window。普通连接从最新约 100 条 messages 所在的 turn boundary 开始发送。带 `message` query 的 permalink 连接从包含目标 Message ID 的页面开始发送；带 `start` query 的缓存恢复连接从浏览器已经加载的全局 offset 开始发送。

Snapshot 包含以下状态：

- Session ID 和名称。
- 当前 client display window 的 messages。
- `messageNumberOffset`、`totalDisplayMessages`、`targetMessageId` 和 `hasEarlierMessages`。
- Streaming 和 idle 状态。
- `subagents` 的任务关系与状态，以及可选的历史分支 `leafEntryId`。
- 当前 model 和 thinking level。
- 可用 thinking levels。
- Queue。
- Rollback 和 restore 状态。
- Session statistics。

首次打开且浏览器没有缓存时，Web 将首个 snapshot 作为加载完成依据。Socket open 只表示连接成功。App 在加载 Workspace 前初始化 Session cache，因此 Chat 首次渲染可以同步取得缓存内容。切回最近查看的 Session 时，Web 先显示最多 50 个 Session 的 IndexedDB LRU snapshot，再连接 Server，并以权威 snapshot 更新 cache。

同一模块以 `usedAt` 维护最多 50 个 Session 的 snapshot 与 UI state，并将二者保存到 IndexedDB；同一个数据库还保存文件路径确认结果。UI state 包括 composer draft、待发送 attachments 和 conversation disclosures。Disclosure key 使用 source entry ID、tool call ID 或 run 中首条 source entry ID，因此 Server snapshot 更新和 earlier-message pagination 不改变该 identity。Attachments 以 Blob 保存，加载 cache 时重建 preview object URL；Session 删除、清理或 UI cache 淘汰时释放对应 URL。数据库名称包含 Pi-Ark base path 与登录 username，实例和账号之间不共享 cache。写入先在内存生效，再以 250 ms debounce 保存；`pagehide` 与 document hidden 时执行 flush。IndexedDB 不可用时，cache 退回当前页面内存。Session snapshot 只包含当前页约 100 条 display message，按当前实测的页面体积（约 0.5 至 1.6 MiB）估算，50 个 Session 的 snapshot 约占 25 至 80 MiB IndexedDB 空间。Settings → Interface 的 Clear browser cache 清空内存与当前实例和账号的 stores；Session JSONL 与 Settings 保持不变。

App 在当前页面内按 Workspace 记录最后查看的 Session。切换 Workspace 时，Session 选择顺序是 URL 指定的 Session、该 Workspace 上次查看的 Session、第一个未归档的普通 Session，选中结果写回 URL。Session 列表与产生它的 Workspace ID 一起保存，请求完成前主内容区显示 Loading sessions，侧栏不渲染上一个 Workspace 的 Session，也不显示空会话提示。切换 Workspace 时，旧 Workspace 尚未返回的列表响应会被丢弃。

App 同时按 Workspace 记录一个尚未发送 message 的新 Session。再次点击 New session 时，如果该 Session 仍出现在最近一次 `session-statuses` 响应的 ID 列表中，App 直接打开它，Composer 从 Session UI cache 恢复草稿。该 Session 产生首条 message 而进入 Session 列表后，记录被清除；记录失效时，New session 新建 Session 并把旧缓存键下的草稿文本复制到新 Session。判断使用每次响应的 ID 列表，已合并的状态 map 保留历史条目，不用于该判断。

### Streaming events

AgentSession subscription 将 pi events 通过 `agent-event` 转发给所有 clients。Web 使用 message start/update/end 更新流式内容，并从 agent start 到 agent settled 保持 active run 状态。assistant message 的 `stopReason` 为 `error` 时，Web 渲染 Session 中保存的 `errorMessage`；折叠 run 的 warning 使用同一字段显示中断原因。`auto_retry_start` 与 `auto_retry_end` 更新 conversation 中的重试提示和 header status，这些提示不写入 Session。pi 在 public `message_end` listener 返回后将 completed message 写入 SessionManager，因此 Server 在下一次 task 中调度 message end、agent settled 和 queue update 后的权威 snapshot。该时序使 snapshot 包含刚完成持久化的 message。Server 为每个 client 保留 display window 起点，并只发送该起点到最新 message 的 projection slice；Agent runtime 继续使用 pi 的 compaction-aware Session projection 生成后续模型上下文。

### Sidebar Session status

`GET /api/workspaces/:workspaceId/session-statuses` 只读取当前 Server process 中已经打开的 AgentHandle，不扫描 Session JSONL。Web 每秒读取该轻量状态列表。每条状态包含 `ready`、`running` 或 `error`、单调递增的 `statusRevision`、完成态使用的 `updateRevision`，以及可选的 error message。

`agent_start` 将状态切换为 `running`。`agent_end` 只记录最终且不再 retry 的 assistant error；`agent_settled` 才将状态切换为 `ready` 或 `error`，因此单条 `message_end` 不会提前结束 spinner。Aborted run 返回 `ready`，但不递增 `updateRevision`。Prompt 在 Agent run 建立前直接失败时，Server 立即进入 `error` 并递增 completed update revision。

Web 的 `SessionStatusView` 使用 `viewedUpdateRevision` 保存当前浏览器已经查看的更新序号，并以 `state === "ready" && updateRevision > viewedUpdateRevision` 计算 unread output。首次收到已有 completed revision 且处于 Ready 的 Session 时，Web 也会显示尚未查看的输出。Running 和 Error 期间暂时隐藏 unread，未查看的更新序号继续保留，回到 Ready 后恢复对应的提示。浏览器在可见的 Agent 页面查看该 Session 时，将当时的 `updateRevision` 确认为已查看序号。Web 根据 `statusRevision` 和同一状态 revision 下的 `updateRevision` 筛选 response，较旧的响应会保留当前状态与查看进度。Web 按 Workspace 在当前页面内存中保存状态，因此切换 Workspace 后返回仍可看到尚未查看的新输出。Error 由 Server runtime state 决定，下一次 Agent run 会更新该状态。

当前 Agent runtime 没有面向 Web 的显式 question lifecycle、question event 或 answer API。Sidebar Question indicator 作为计划能力保留；后续需要先定义 runtime question state 与 answer transport，再加入状态优先级和图标。

SessionList 将每个 Session 渲染为高度 32 px 的单行 row，标题使用 ellipsis，更新时间通过 `title` attribute 格式化为 `Last Updated: yyyy-mm-dd hh:mm:ss`。Sessions header 的操作顺序是 archive visibility、internal link、create group 和 create Session。原 create-group toolbar 改为 Notebook 入口；App 将 `notebook` 保存为 URL page，并在主内容区 lazy-load Notebook component。

### Prompt 与 attachments

WebSocket prompt 可以包含文字和 base64 attachments。Attachment service 执行文件数量、单文件大小和总大小检查，然后保存到 Session attachment directory。

Prompt 文字追加保存后的文件名和绝对路径。支持的图片同时作为 pi image content 发送；普通附件通过路径供 Agent tools 使用。

Session idle 时调用 `session.prompt()`。Session streaming 时，Pi-Ark 将新 message 记录为 Follow-up queue item，立即广播轻量 `queue-state`，再调用 `session.followUp()`。Web 在两种状态下都显示 Send 与 Stop；idle 状态的 Stop 为 disabled，streaming 状态的 Send 使用 Follow-up 语义。Web 在发送 active prompt 前创建本地 Scheduling row；该 row 使用 match text 和预期 occurrence count 与后续 Server `queue-state` 对账，避免相同 Follow-up text 导致提前移除。Attachments 的浏览器编码与 Server 保存仍在 Queue 确认之前执行。

### Queue

Runtime 启动时，Pi-Ark 从 pi 的 steering/follow-up queues 建立带随机 ID 的 UI metadata。Queue update event 会按 mode 和 text 复用已有 ID。每次 Queue 权威状态变化都会递增 `queueRevision`，并通过轻量 `queue-state` 发送 Queue items；该 event 不清除 display projection cache，也不生成 conversation snapshot。Web 的 Scheduling row 不写入 Server queue metadata；对应权威 item 出现在 `queue-state` 后，Web 移除本地 row。WebSocket send、Server error 或连接失败会将对应本地 row 标记为 Failed。

pi public API 提供追加和整体清空，没有单 item mode、删除或排序方法。重新排序、切换 mode、取回编辑或合并 Follow-up 时，AgentService 先修改 Pi-Ark queue metadata，递增 queue rebuild version，并立即广播带 `confirmedOperationId` 的 `queue-state`。Web 将本地 optimistic operation 叠加在最后一份权威 Queue 上；对应 operation ID 被 Server 确认后移除 optimistic layer。HTTP response 也返回 Queue items、revision 和 operation ID；失败时 Web 移除 optimistic operation，Server 则从 pi 当前 Queue 恢复 metadata 并广播更高 revision 的状态。

Queue rebuild 执行以下过程：

1. 复制当前目标 Queue 与 rebuild version。
2. `clearQueue()`。
3. 按新顺序重新提交 Steering items。
4. 按新顺序重新提交 Follow-up items。
5. 如果 rebuild 期间 version 已变化，则使用最新目标 Queue 再执行一轮。
6. version 未变化时，从 pi Queue 重新同步 metadata，并广播最终 `queue-state`。

同一个 Session 同时只运行一个共享的 rebuild promise。快速连续操作可以修改目标 Queue，并共用当前 rebuild；Server 不再返回 Queue update in progress。该流程保留 Pi-Ark queue item 中的 image content。取回编辑会 optimistic 地移除指定 item，并在 response 到达后将 text 放回 composer；Web 在 composer 已有文字或 attachments 时先显示覆盖确认。合并 Follow-up 会 optimistic 地按照当前 Follow-up 顺序使用两个换行符连接 text；Server rebuild 同时连接对应 image content。

### Fork

Fork 使用单独打开的 SessionManager，并调用 `createBranchedSession(entryId)`。Target 必须是当前 active branch 上已经持久化的 assistant entry。Fork 不要求当前 AgentSession idle，因此 AI working 时可以从更早的已完成 assistant output 创建分支；尚未持久化的流式 output 没有 source entry ID，也不会提供 Fork action。该操作不会移动当前 Session 的活动 leaf，也不会中止原 Session 的 Agent run。新 Session 建立后，浏览器设置名称并切换到新分支。

### Rollback 与 Restore

可回退状态要求 Session idle、queue 为空，并且活动 leaf 不是已有 rollback marker。AgentService 在当前 branch 中查找最后一条 user entry，并优先使用该 entry 后最后一个完成的 assistant output 作为 rollback target；如果 response settled 后仍缺少最终 assistant output，则使用该 turn 最后的 assistant/tool message 作为 fallback target。

Rollback 将 SessionManager 移动到 user entry 的 parent，并追加 `pi-ark.rollback` custom entry。Marker 保存以下数据：

- rollback target ID。
- 原分支 leaf ID。
- 原 user message text。

Snapshot 根据活动 leaf 暴露 rollback state。Web 将 user text 放回 composer。Restore 移动回保存的 leaf，并追加 `pi-ark.rollback-restored` marker。发送替代 message 后，rollback marker 不再是活动 leaf，restore 入口随之失效。

### Delete 与 shutdown

Delete 会清空 queue、中止运行中的 Agent、释放 subscription 和 runtime、关闭 clients，并删除 JSONL、Session attachment directory 和 metadata。

Server shutdown 会依次清空所有 queue、中止 active Agent、释放 runtime 并关闭 WebSocket clients。

## Conversation projection

Server 使用 `SessionManager.getBranch()` 读取当前活动 branch 的完整 entry path，并通过 `sessionEntryToContextMessages()` 转换可显示 entry。该 display projection 保留 compact 前的原始 user、assistant 和 tool messages，并将每个 compaction entry 转换为一条 `compactionSummary` message。Compaction display message 还包含 `compaction`，其中包含 `tokensAfter`、`systemPromptTokens`、`summaryTokens`、`retainedTokens`、`durationMs`、`reason`、`summarizerInputTokens` 和 `summarizerOutputTokens`。Server 使用 `buildSessionProjection(entries, compactionEntryId, byId)` 重建该次压缩当时的上下文，再通过 SDK 的 `getCurrentSystemMessage()` 与 `estimateTokens()` 计算各组成；原生 entry 的 `tokensBefore` 与 `usage` 提供压缩前及摘要生成时的用量。Server 以 `performance.now()` 测量 `compaction_start` 到成功 `compaction_end` 的耗时，并通过 `appendCustomEntry()` 追加 `pi-ark.compaction-timing`，其 data 包含 `compactionEntryId`、`durationMs` 和 `reason`。压缩结束后调度权威 snapshot。System message 与 `display: false` 的 custom message 不进入 Web snapshot。AgentHandle 缓存该 display projection，Session message/tree 变化时清除 cache。pi JSONL 和 Agent runtime 的 compaction-aware context 保持原样。

Server 默认向每个 WebSocket client 发送最新约 100 条 messages。分页起点向前对齐到 user、compaction summary 或 branch summary 边界，避免从一个 turn 的 assistant/tool result 中间开始。Snapshot 使用 `messageNumberOffset` 保存当前 slice 之前的 message 数量，并使用 `totalDisplayMessages` 保存完整 projection 数量；这些 numeric fields 只服务于分页。每条持久化 projection message 还包含七字符短 `messageId`，格式为 `m` 加六位小写 base36。Server 使用 Session ID 生成 31-bit 奇数 multiplier 与 offset，再对 source entry 在 append-only Session entries 中的固定位置执行一一映射，因此同一 Session 中的 ID 不重复，并且新增 entry 不会改变已有 ID。Session source entry 上限是 10000000，达到上限后新的 prompt 返回错误。点击 Show earlier messages 后，Web 发送 `load-earlier`；Server 将该 client 的 window 起点向前移动一页，并发送扩展后的权威 snapshot。Permalink、sticky User、tool source link 和 target highlighting 使用 `messageId`；Fork 与 Rollback 继续使用 pi source entry ID。

`buildConversationSegments()` 只以 user message 划分 turn；compaction summary、branch summary、assistant message 与 tool result 都保留在当前 AI response 中。每轮 response 的第一个 segment 带 `aiStart` 标记，Web 只在该位置显示一次 AI 头像和 `AI` 标签。分页内容从 response 中间开始时，当前页面中的 response 前缀共同使用一次 `aiStart`。User source message 保留独立的用户头像、`User` 标签、短 Message ID 与操作按钮。每条 User source message 使用包含 header 与 content 的全宽色带；每个 theme 分别提供协调后的 User background、上/下 separator colors 和 User accent color，并保持 User accent 与该 theme 的 AI accent 可区分。色带没有左右 border、圆角或阴影，并延伸到当前 conversation 内容列的左右边界。色带通过上下 separator 及其外侧留白区分相邻内容，并使用左侧、上侧较大的非对称内部 padding。User permalink target 调整上下 separator 与 background，不改变色带外部尺寸。User 与 AI 的 role avatar 和 label 使用更大的尺寸，User 使用独立于 AI accent 的颜色。角色 header 与后续 feed 内容使用独立布局，因此头像不会缩进后续内容。含普通 text 或 image 的 assistant source message 在末尾渲染操作行：完成态显示 Copy Markdown、Fork session 和 Info，流式状态显示 Info；只包含 reasoning 和 toolCall 的 source message 不渲染操作行。Info 控制 source information 与 metrics 的显示。

- 没有 tool activity 的 turn 按 source message 和 content block 顺序展示为连续 feed。
- Active turn 将截至最新 tool activity 的连续过程放入带 Running 状态的 run collapse，并在外部保留后续的非工具 assistant output；没有保存状态时，`RunCollapse` 在 active 状态开始时默认展开，其中的 tool details 默认关闭。用户手动改变的 Run、Tool、Reasoning 和 Message Info disclosure 状态写入当前 Session 的 browser cache，并在切换 Session 或刷新页面后恢复。
- 已完成 tool turn 将最后一条非工具 assistant output 之前的过程放入 run collapse；`RunCollapse` 观察 active→completed 转换并自动折叠并更新缓存状态。permalink target 打开时展开对应 details，已保存的折叠状态不会遮挡目标；用户随后可以手动折叠。
- Idle 且缺少最后一条非工具 assistant output 的 tool turn 将全部过程放入 run collapse，并追加 warning segment。

Turn renderer 在 segment 渲染前扫描当前页面的 projection messages，并通过 `toolCall.id` 与 tool result 的 `toolCallId` 建立 call/result 对应关系。Renderer 随后按每条 source message 的 content block 顺序生成 text 与 tool feed items。Text item 处理 text、image 和 reasoning；reasoning 使用较小字号与和普通 text 一致的行高。App 从 `/api/ui` 读取 Global `hideReasoning`，并传给 Chat renderer；启用后 renderer 跳过 thinking block 的 DOM 输出，Server snapshot、Session JSONL 和 model context 保持原内容。tool call 与 result 合并成单行折叠项，tool logo 位于 details summary 内，使展开内容与 details 左边界对齐。Completed 使用中性色；Running、Failed、Result 和 Saved 分别使用 theme 的 warning、danger、info 和 saved colors，并且只改变同一层 details 的 border、logo 与 status text。Tool permalink target 使用 details 内侧的 accent 标识，不增加外层 padding、背景或包围框。每个 theme 分别提供 Run palette 与 Tool palette：Run group 使用该 theme 的 tint surface，Tool row 和 Reasoning 使用更中性的 surface，并具有独立的 open surface 与 border color。Paper 的 Run group 使用低饱和 sage-gray tint，Tool row 使用浅白色；dark themes 和 Snow 使用对应 accent 倾向的外层 Run surface 与更亮的中性 Tool surface。Compact 与 branch summary 也使用 tool feed item。Compact 的收起高度为普通 tool row 的 3 倍，并展示压缩前后的用量、估算的上下文组成和压缩耗时。展开 tool item 后先显示 Call/Result 的消息 link 按钮，整段按钮包含 source Message ID 与复制图标；tooltip 使用 portal 到 document body 的 fixed 浮层。页面不展示短 Message ID；User header、sticky User 与 source link 的 aria-label 和复制链接继续使用该 ID。其后显示 arguments、result 或 summary。`buildToolCallGroups()` 接收 `hideReasoning`，在已配对结果的基础上按可见内容对连续的工具调用分组。开启 Hide reasoning 后，隐藏的 thinking block 和独立的 thinking-only assistant message 会保留在原始消息序列中，其前后的连续调用归入同一分组。可见的 Reasoning、普通正文、图片、Compact、branch summary 与独立结果继续中断分组；包含正文或图片的 message 中的 tool calls 保持原有显示。包含 `subagent` 调用的 message 独立显示，并中断前后的连续调用分组；`subagent` 的 summary 高度为普通工具行的 3 倍。`ToolCallSequence` 按单个 call 计数，默认隐藏较早调用并保留最后 3 个，使用 `show more tool call` / `show less tool call` 切换。分组使用首个 source message 与 call 的稳定标识保存 disclosure；早期 message 或 result 的 permalink target 在首次访问时展开分组。Arguments renderer 按顶层 key 分组，使用 heading 样式显示 key，并在下一行显示格式化 value；嵌套 object/array 使用无 JSON braces 和 quotes 的缩进文本。

每条持久化 source message 继续保留短 Message ID、entry ID 和 permalink anchor。配对的 tool result 不重复渲染，但 tool item 内保留 result anchor。浏览器 permalink 打开外层 run 并高亮对应 source message 或 tool item；`pi-ark://` 是 feed 中提供的 message link copy 格式。Warning segment 是前端显示状态，不写入 pi JSONL，也不分配 Message ID，不参与 Fork 或 Rollback。

Chat header 左侧按 title、rename action、runtime status 排列；title group 不占用剩余宽度，title 使用内容宽度并受 max-width 限制，rename action 与 title 保持 5px 间距。右侧只渲染 context usage 百分比数字和 Session information。Session information panel 保存 Session URL copy 与 conversation width controls。Web 将已知 lifecycle 和操作状态视为普通状态，其余错误文本使用 error status；error status 显示红灯、红色系背景与边框。移动端仅对 status text span 应用省略，status box 保持 visible overflow，使红灯和 halo 不受裁切。移动端 App Grid 使用 `minmax(0, 1fr)`，使 Chat 主列可以缩小到 viewport 宽度，避免 composer toolbar 的 min-content width 扩大整个页面。Conversation 记录用户是否位于底部附近；底部用户继续跟随 event，向上阅读的用户保留当前 scroll position。Web 根据 user feed item top 与 scroll container top 的关系选择 sticky User bar，因此向上和向下滚动都会在 user item 越过顶部时切换。User bar 使用真实高度与等量负 margin 保持布局位置，并使用覆盖整条 bar 的 button 与不透明背景遮住下方内容；展开的 run summary 使用 sticky positioning 显示在该 bar 下方。Composer 和 queue 作为 Chat Grid 的底部行参与布局，conversation 使用剩余高度。

## Settings 与 pi resources

### Pi-Ark agent directory

Pi-Ark 默认使用 `PI_ARK_HOME/pi-agent`。`PI_ARK_AGENT_DIR` 可以覆盖该路径。

首次初始化时，Server 可以从 `PI_ARK_MIGRATE_AGENT_DIR` 或启动前的 `PI_CODING_AGENT_DIR` 复制以下文件：

- `auth.json`
- `settings.json`
- `models.json`
- `models-store.json`

迁移状态写入 `.pi-ark-migration.json`。完成初始化后，Server 将 `PI_CODING_AGENT_DIR` 设置为 Pi-Ark agent directory。

安装器创建 `PI_ARK_AGENT_DIR/secrets`，权限 0700，用于存放 `mcp.json` 中 `!command` 引用的密钥文件。安装过程只创建目录，不写入内容。

### Global settings

SettingsService 使用 pi 的 SettingsManager 和 ModelRuntime。Global settings 分布在以下文件：

- UI settings（`ui.theme`、`ui.hideReasoning` 和 `ui.markdownLineBreaks`）、Workspace registry 和共享 `preferences`（Global prompt append、Files preferences、Terminal shell 设置和 Skills 停用清单）：`PI_ARK_HOME/config.json`。
- Enabled models、default provider/model/thinking、queue modes、compaction 和 retry：`PI_ARK_AGENT_DIR/settings.json`。
- Credentials：`PI_ARK_AGENT_DIR/auth.json`。
- Custom models：`PI_ARK_AGENT_DIR/models.json`。

`ui.markdownLineBreaks` 是 boolean 字段，默认值为 `true`，对应 Settings 中的 Keep line breaks。读取历史配置时，缺少该字段的配置使用默认值。UI 保存入口在串行原子更新中保存新值；旧请求省略该字段时保留当前保存值，历史配置也缺少该字段时保存 `true`。提供该字段时，保存入口验证字段为 boolean，非法值返回 HTTP 400。`SettingsService.getGlobal()` 返回 `markdownLineBreaks`，兼容的 `saveGlobal()` 入口透传可选字段。

API key 通过 `ModelRuntime.login(provider, "api_key", interaction)` 写入。保存 credential 的断开操作调用 `ModelRuntime.logout(provider)`。Settings response 返回 credential 状态、来源和是否可以断开；credential 内容保留在服务端。

模型 checkbox 使用 `SettingsManager.getEnabledModels()/setEnabledModels()`。SettingsService 通过 pi 的 `resolveModelScopeWithDiagnostics()` 解析 exact reference、glob 和 thinking suffix；Session model API、模型切换校验和新 Session 创建使用同一 scope。全部当前可用模型均勾选时，Pi-Ark 将 `enabledModels` 保存为 `undefined`，沿用 pi 的“全部可用模型”语义。模型偏好保存要求至少一个当前可用模型，并要求 default 属于已勾选模型。

断开 Provider 后，SettingsService 从断开前的已勾选模型中保留仍可用的模型。没有剩余已勾选模型且还有其他可用模型时，SettingsService 选择第一个可用模型，并同步 default 与 thinking level。

### Terminal 设置

Server shell 配置保存在 `PI_ARK_HOME/config.json` 的 `preferences.terminal` 中，字段为 `shell`、`executable`、`args` 与 `env`。`shell` 接受 `auto | bash | zsh | fish | pwsh | powershell | git-bash | wsl | custom`；`executable` 是自定义程序的绝对路径，`args` 是附加参数的字符串数组，`env` 是字符串值的环境变量对象。缺失字段使用默认值（`shell: "auto"`、`executable: ""`、`args: []` 与 `env: {}`）。保存时校验配置结构及所选程序的可用性，自定义程序校验绝对路径和可执行状态；Windows 的自定义程序使用 `.exe` 或 `.com` 文件。

`discoverTerminalProfiles()` 根据 PATH 与平台的常见安装路径探测程序，并返回每个 profile 的 `id`、`label`、`executable`、`args` 与 `available`。Settings 选择器展示可用的 profiles，并提供 Auto 与 Custom executable。Auto 在 Windows 上优先使用 `pwsh`，其次使用 `powershell`；macOS 优先使用可执行的绝对 `SHELL` 路径，其次使用 `/bin/zsh`；Linux 优先使用可执行的绝对 `SHELL` 路径，其次使用 `/bin/bash`。

程序启动使用 node-pty 的 executable 与 args 参数，用户填写的 `args` 逐个追加到 profile 的默认参数后。PowerShell profiles 默认提供 `-NoLogo`，启动 PowerShell 时再追加 `-NoExit -Command` 与 UTF-8 初始化命令，设置 Console 的输入编码、输出编码和 `$OutputEncoding`，随后保留交互 shell。Unix 根据 `LC_ALL`、`LC_CTYPE` 和 `LANG` 确定当前字符编码，结合 `locale -a` 的可用列表保留有效的 UTF-8 locale，或选择平台的可用 UTF-8 locale。最终环境包含 `TERM=xterm-256color` 和 `COLORTERM=truecolor`，用户的 `env` 最后覆盖继承的环境变量。

Server shell 配置由所有 Workspace 共用，在创建新 Tab 时读取。浏览器外观使用 `fontFamily` 与 `fontSize`，保存在 localStorage 中，并通过偏好变更事件立即更新已打开的 xterm。默认字号为 13 px，范围为 10–30 px；默认字体列表为 `ui-monospace, "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace`，浏览器为中文字符选择可用的备用字体。归一化时将完整匹配历史默认值的字体列表更新为当前默认值，并保留合法字号；其他自定义字体保持原值。该迁移覆盖读取、保存与偏好变更事件，读取时在内存中生效，后续保存时写入新的字体列表。

### Subscription OAuth

Provider 的 `auth.oauth.isSubscription` 决定 UI 是否显示 subscription login。AuthFlowService 将 pi OAuth interaction 转换为可轮询状态，支持 info、auth URL、device code、progress、text/secret/manual code prompt、select prompt 和 cancel。

SettingsService 调用 `ModelRuntime.login(provider, "oauth", interaction, { getDeviceId })`。`getDeviceId` 使用 `SettingsManager.getOrCreateDeviceId()`，首次需要时生成 UUID，并将稳定的安装实例标识保存到 `PI_ARK_AGENT_DIR/settings.json`。OpenAI 的 ChatGPT subscription 登录使用该全局值作为 agent host ID。

Flow、events 和待回答 prompt 保存在服务内存中。每个 Provider 同时保留一个 pending flow；启动同一个 Provider 的新登录时，AuthFlowService 会取消此前的 pending flow，使 OAuth callback listener 和 ModelRuntime credential 操作可以释放。不同 Provider 的登录 flow 可以同时进行。Flow event 最多保留最近 50 条。

### Skills

`resource-loader.ts` 定义三个 skill 目录：

| 作用域 | 目录 | 来源标记 |
|---|---|---|
| Built-in | `<install-root>/skills` | `built-in` |
| Global | `PI_ARK_AGENT_DIR/skills` | `managed` |
| Workspace | `<workspace>/.pi-ark/skills` | `managed` |

安装根目录由 `resource-loader.ts` 从自身模块位置向上解析，源码的 `apps/server/src` 与 release 的 `apps/server/dist` 都指向项目或安装根目录。

`createResourceLoader()` 把存在的目录加入 `additionalSkillPaths`，并通过 `skillsOverride` 按 `skill.filePath` 判断作用域，过滤对应停用清单中的名称。loader 同时挂载 `createMcpExtension()` 与 `createCodemodeExtension()`。`codemode` 注册为默认停用；Session 把 `codemode` 加入工具列表，再用初始活动工具集合将其排除。MCP extension 在 Session 启动时根据启用且 `exposure` 为 `codemode` 的 server 配置把 `codemode` 加入活动工具，连接后的工具即可从脚本调用。

`SkillService` 每次请求调用 `loadSkillsFromDir()` 扫描三段目录。扫描顺序为 Built-in、Global、Workspace，同名 skill 保留先发现的项，后续同名项写入诊断。`SkillService` 保存选择时校验 `disabledBuiltin`、`disabledGlobal` 与 `disabledWorkspace`，对已注册的 Workspace 丢弃扫描结果中不存在的名称，去重后写入 `config.json`。保存完成后 `SkillService` 调用 `AgentService.reloadIdleSessions()`，对非 running 的 Session 执行 `session.reload()`；正在运行的 Session 保持当前资源集合。

`preferences.skills` 的读取、归一化与保存位于 `config.ts`。字段默认值为空数组与空对象；`disabledWorkspace` 以 Workspace ID 为键，保存时保留其他 Workspace 的停用记录。

### MCP server

`McpService.ensureConfig()` 在 Server 启动时创建 `PI_ARK_AGENT_DIR/mcp.json`，文件已存在时保留原内容。初始内容为 `playwright` server：`command` 为 `npx`，`args` 为 `@playwright/mcp@0.0.85`、`--browser=chromium`、`--headless` 与 `--caps=config,network,storage,devtools,vision`，`enabled` 为 `false`，`exposure` 为 `codemode`，并带 `description`。`--browser=chromium` 使用 Playwright 自带的 Chromium，`--headless` 适配无显示的服务器。已有配置的 `args` 只含 `@playwright/mcp@0.0.85` 与可选的 `--caps` 时，`ensureConfig()` 补上 browser 与 headless 参数，其他自定义参数保持原样。

`McpService.list()` 运行 `process.execPath <pi-core-cli> mcp list --json`，工作目录为目标 Workspace，环境变量设置 `PI_CODING_AGENT_DIR` 与 `NO_COLOR=1`，超时 120 秒。Server 把返回的 `state` 映射为 `connected`、`starting`、`needs-sign-in`、`failed`，并把 `enabled` 为 false 的 server 显示为 `disabled`；`tools`、每个 server 的 `error` 与顶层 `errors` 进入列表和诊断。

`McpService.setEnabled()` 校验 server 名称与 boolean，串行读取 `mcp.json`，只更新目标条目的 `enabled` 字段，以 temporary file 加 rename 原子写入，然后调用 `reloadIdleSessions()`。`McpService.setAdvanced()` 只接受 `playwright`，过滤 `args` 中已有的 `--caps=` 后按开关追加或移除 `--caps=config,network,storage,devtools,vision`，写回配置并重载空闲 Session。`mcp.json` 解析失败、条目不存在或写入失败时返回对应的 HTTP 错误。

`McpService.browserStatus()` 检查服务账号 home 下的 `.cache/ms-playwright`，识别 `chromium_headless_shell-<数字>` 与 `chromium-<数字>` 目录并优先使用 headless shell。`installBrowser()` 在状态为 `not-installed` 或 `failed` 时执行 `npx @playwright/mcp@0.0.85 install-browser chromium --only-shell`，设置 `npm_config_yes=true`，超时 15 分钟，并保留最多 64 KiB 的安装日志。安装目录出现后状态变为 `installed`；命令失败或没有生成目录时保持 `failed` 并保留日志。

`scripts/pi-ark.mjs` 的 `mcp` 子命令查找项目或安装包内的 pi core CLI，以 `PI_ARK_AGENT_DIR` 作为 `PI_CODING_AGENT_DIR`，把 `list`、`add`、`remove`、`login` 与 `logout` 参数透传给 `pi mcp`，并沿用子进程退出码。

`scripts/build-release.mjs` 在 staging 目录创建 `skills/`，把源码根目录的 `skills/` 整体复制到安装包；服务端从安装根目录读取 Built-in skill。

### System prompt

Global system prompt 的可选文件是：

```text
PI_ARK_AGENT_DIR/SYSTEM.md
PI_ARK_AGENT_DIR/APPEND_SYSTEM.md
```

Global preview 与实际 runtime 共用 DefaultResourceLoader 的创建流程。Loader 显式选择 Global replacement/append 文件，并通过 `appendSystemPromptOverride` 追加 `preferences.agent.systemPrompt.append`。Workspace 的 AGENTS.md 仍作为项目上下文提供。SettingsService、ResourceLoader 与 AgentSession 都使用 `SettingsManager.create(cwd, agentDir, { projectTrusted: false })`，将 pi 的设置来源统一到 Global。

`PI_ARK_HOME/config.json` 的共享 preferences 使用以下结构：

```json
{
  "preferences": {
    "agent": {
      "systemPrompt": { "append": "" }
    },
    "files": { "showHiddenFiles": true, "maxPreviewSizeMb": 10 },
    "terminal": { "shell": "auto", "executable": "", "args": [], "env": {} },
    "skills": {
      "disabledBuiltin": [],
      "disabledGlobal": [],
      "disabledWorkspace": {}
    }
  }
}
```

缺少 preferences 的既有 Global config 使用以上默认值。`GlobalPreferences.agent` 仅包含 `systemPrompt.append`，`preferences.skills` 保存 Skills 的停用清单，读取配置时归一化为上述结构，历史 Global `agent.tools` 选择由统一启用的文件工具列表替代。所有 Workspace 使用同一份配置；历史 `<workspace>/.pi-ark/config.json` 保留为历史数据，当前实现从 Global 取得提示词、文件偏好与 Terminal 设置。`ensureWorkspaceState()` 创建 Session directory。Preferences GET 返回归一化后的 preferences，PUT payload 仅包含 `files`；system prompt PUT 使用独立的 `{ "append": "..." }` payload 更新 append；Terminal PUT 使用 `TerminalSettings` 更新 `preferences.terminal`。这些写入入口共享 Global config 的串行原子写入，各入口保留其他设置字段。

### Settings 的页面缓存

Settings 首次访问后保持挂载，并使用独立的 Suspense 容器，与 Files 和 Terminal 的 lazy loading 分开。类别顺序为 Interface、Models & providers、Agent behavior、Skills、MCP、Files、Terminal、Maintenance 和 Account。切换页面时隐藏 Settings 的 DOM，保留已加载数据、所选类别、草稿（提示词与 Terminal shell 配置）、disclosure 和各类别的滚动位置。该状态位于当前页面内存中。Global settings 与模型清单独立加载，首屏以 Global settings 为依据；prompt preview 在展开时加载，Skills 与 MCP 数据在首次进入对应类别时加载，Terminal 配置与 release 信息在首次进入对应类别时加载。

Terminal 的自定义程序、附加参数和环境变量通过 Save shell settings 提交，Cancel 恢复已保存的内容；选择普通 profile 且其他字段保持已保存内容时立即保存。Terminal 使用独立的保存队列与请求序号，保留请求期间的新编辑内容。该类别的 Refresh settings 等待已有保存队列，再请求 Server 的设置和 profiles，并保留尚未保存的草稿。其他类别的 Refresh settings 读取 Global settings 和模型数据，Maintenance 同时刷新 release 信息；Skills 与 MCP 使用各自的 Refresh 读取资源列表。离开页面时清空尚未提交的 API key，并暂停 subscription 轮询。

### Pi-Ark release 管理

Release manager 从 release 目录的 `RELEASE.json` 读取 Pi-Ark 与 bundled pi core 版本，并通过 GitHub Releases API 查询 stable channel。开发 checkout 没有 `RELEASE.json`，因此只提供版本和路径信息。

Instance-aware CLI 的 `update` command 执行以下流程：

1. 查询 GitHub 的 latest release，并选择当前操作系统与 architecture 对应的 artifact。
2. 下载并解压到临时目录；Linux 与 macOS 使用 tar，Windows 使用 PowerShell 的 `Expand-Archive`。
3. 检查 `RELEASE.json` 的 platform/architecture、必要的 Server/Web 文件、pi SDK import 和 node-pty native module。
4. 将 release 复制到 `PI_ARK_INSTALL_PREFIX/releases/<version>`。
5. 保存当前 release 为 `previous`，并写入 `pending-release.json`；POSIX 使用临时 symlink rename 切换 `current`，Windows 使用原子 JSON 替换更新 `release-state.json`。
6. Web update API 在返回响应后触发 Server 正常关闭，释放 Agent runtime、WebSocket 和 Fastify；portable 后台管理器或 Linux systemd 下的 CLI supervisor 从新的 `current` 启动服务。
7. CLI supervisor 请求新进程的 `/api/health`；启动检查通过后移除 pending state，检查失败时恢复 previous release 并重新启动。

CLI 在上述阶段输出状态行：检查 latest release、下载（每两秒输出已下载大小）、校验、安装、切换版本和重启。重启等待期间，systemd 路径每五秒输出一次已等待时间，portable 路径在停止与启动阶段每十秒输出一次。

Instance-aware CLI 的 `rollback` command 对调 `current` 与 `previous`，写入 pending release state，并使用相同的健康检查与重启流程。Global data 和 Workspace data 位于 release 目录之外，更新与回退会保留这些数据。Maintenance 与 CLI 共享相同的 release state，页面展示 previous release 和稳定 CLI 的完整 Node 调用命令。

日常迭代使用 `<next-version>-dev.<iteration>` SemVer prerelease。开发 artifact 安装到本机 `/opt/pi-ark-dev/releases/<dev-version>`，并通过同一套 preflight、symlink 和 systemd 流程运行；该流程不会创建 Git tag 或 GitHub Release。正式 release 需要明确的发布安排。

## 数据存储

### Global data

| 路径 | 内容 |
|---|---|
| `PI_ARK_HOME/config.json` | Listen、TLS、auth hash、Workspace registry、UI settings（`theme`、`hideReasoning` 和 `markdownLineBreaks`）和共享 preferences（提示词、Files、Terminal shell 与 Skills 停用清单） |
| `PI_ARK_HOME/tls/` | Setup 生成的 TLS key 和 certificate |
| `PI_ARK_HOME/auth-sessions.json` | 登录 token 的 SHA-256 哈希、expiry 与 credential fingerprint |
| `PI_ARK_AGENT_DIR/auth.json` | pi provider credentials |
| `PI_ARK_AGENT_DIR/settings.json` | pi Global defaults |
| `PI_ARK_AGENT_DIR/mcp.json` | MCP server 定义、`args`、`enabled`、`exposure`、`toolExposure`、`timeout` 与 `description` |
| `PI_ARK_AGENT_DIR/skills/` | Global user skills |
| `PI_ARK_AGENT_DIR/models.json` | Custom provider/model config |
| `PI_ARK_AGENT_DIR/SYSTEM.md` | 可选 Global replacement prompt |
| `PI_ARK_AGENT_DIR/APPEND_SYSTEM.md` | 可选 Global append prompt |

### Workspace data

| 路径 | 内容 |
|---|---|
| `<workspace>/.pi-ark/sessions/*.jsonl` | pi session tree |
| `<workspace>/.pi-ark/subagent-runs/*.json` | 委派关系、配置快照、状态、结果引用与用量 |
| `<workspace>/.pi-ark/notebook.md` | Workspace Notebook 的 UTF-8 Markdown 文本 |
| `<workspace>/.pi-ark/skills/` | Workspace user skills |
| `<workspace>/.pi-ark/sessions-meta.json` | Pin、Archive、groups 和 group definitions |
| `<workspace>/.pi-ark/attachments/<session>/` | Session attachments |

Global config、Session metadata 和 Workspace Notebook 使用 temporary file 加 rename 的方式写入。Global config 使用服务进程级 write queue，Session metadata 按 Workspace 使用 write queue，Notebook 按目标文件使用 write queue。Web Notebook 在输入停止约 300 ms 后保存，并在 blur 或页面卸载时提交尚未保存的内容；同一页面的请求通过 Promise chain 按编辑顺序发送。

### Browser-local preferences

浏览器 localStorage 保存侧栏状态和宽度、Workspace 展开状态、conversation width、Files 文件列表宽度和最近应用的 theme。`pi-ark-files-browser-width` 保存桌面 Files separator 调整后的文件列表宽度；移动端的上下堆叠布局不使用该宽度。

Terminal 使用 `pi-ark-terminal-appearance` 保存 `{ "fontFamily": "...", "fontSize": 13 }`，使用 `pi-ark-terminal-active:<window.location.pathname>:<workspaceId>` 保存每个 Workspace 最近选择的 Terminal Tab 标识。字体偏好变更通过当前页面的自定义事件和同源浏览器标签页的 storage event 同步。xterm 的显示状态保存在当前页面的已挂载组件中，Tab 的完整输出历史由 Server 的内存保存。

## HTTP API

### Public

| Method | Path | 用途 |
|---|---|---|
| GET | `/api/health` | Health check |
| POST | `/api/auth/login` | 登录 |

### Auth 与 UI

| Method | Path | 用途 |
|---|---|---|
| GET | `/api/auth/session` | 当前登录状态 |
| POST | `/api/auth/logout` | 退出 |
| GET/PUT | `/api/ui` | 读取或立即保存 `theme`、`hideReasoning` 与 `markdownLineBreaks`；`markdownLineBreaks` 默认为 `true`，PUT 省略该字段时保留当前值 |

### Workspace 与 Files

| Method | Path | 用途 |
|---|---|---|
| GET/POST | `/api/workspaces` | 列出或添加 Workspace |
| PATCH/DELETE | `/api/workspaces/:workspaceId` | 重命名或关闭 Workspace |
| GET | `/api/directories` | 目录建议 |
| GET | `/api/workspaces/:workspaceId/files` | 目录列表 |
| GET | `/api/workspaces/:workspaceId/file` | 文本或图片 preview metadata；执行 Global preview limit |
| POST | `/api/workspaces/:workspaceId/file-links/resolve` | 批量确认文件路径并返回 Files 的目标路径 |
| GET | `/api/workspaces/:workspaceId/image` | Files/Markdown image stream；执行 Global preview limit |
| GET | `/api/workspaces/:workspaceId/download` | 原始文件 stream download；不执行 preview limit |
| GET/PUT | `/api/workspaces/:workspaceId/notebook` | 读取或自动保存 Workspace Notebook |

### Terminal

| Method | Path | 用途 |
|---|---|---|
| GET | `/api/workspaces/:workspaceId/terminals` | 返回 `{ terminals: TerminalInfo[] }` |
| POST | `/api/workspaces/:workspaceId/terminals` | Body 为 `{ cols?: number, rows?: number }`，创建 Tab 并返回 HTTP 201 与 `TerminalInfo` |
| DELETE | `/api/workspaces/:workspaceId/terminals/:terminalId` | 关闭 Tab，释放 PTY 与输出，返回 HTTP 204 |

这些入口均校验 Workspace，Terminal 标识按 Workspace 查询。创建时默认使用 100 列与 30 行，列数和行数分别接受大于等于 2 与大于等于 1 的整数。返回的 `TerminalInfo` 使用以下结构：

```ts
interface TerminalInfo {
  id: string;
  title: string;
  createdAt: string;
  status: "running" | "exited";
  exitCode?: number;
  shell: string;
  cols: number;
  rows: number;
}
```

`createdAt` 是 ISO 时间，`shell` 是实际启动的可执行程序路径。

### Settings

| Method | Path | 用途 |
|---|---|---|
| GET/PUT | `/api/settings/global` | Global defaults（包括 `theme`、`hideReasoning` 和 `markdownLineBreaks`）与兼容的 credential 保存入口；PUT 的可选 `markdownLineBreaks` 透传到 UI 保存逻辑 |
| PUT | `/api/settings/agent-defaults` | 立即保存 message queue、compaction 和 retry defaults |
| GET | `/api/settings/models` | Provider catalog model list |
| GET/PUT | `/api/settings/model-preferences` | 已认证 Provider 的模型清单、checkbox、default 和 thinking level |
| POST | `/api/settings/providers/:providerId/api-key` | 保存指定 Provider 的 API key |
| DELETE | `/api/settings/providers/:providerId/credential` | 删除指定 Provider 的保存 credential |
| GET | `/api/settings/session-models` | 当前已勾选且可用的 Session models |
| GET/PUT | `/api/settings/system-prompt` | 读取 effective prompt preview，或保存 Global append |
| GET/PUT | `/api/settings/preferences` | GET 返回归一化的共享 preferences（包含 `terminal`）；PUT 使用仅含 `files` 的 payload 更新 Files preferences |
| GET/PUT | `/api/settings/terminal` | GET 与 PUT 均返回 `{ settings, profiles, platform }`；PUT body 为 `{ shell, executable, args, env }`，保存 Global Terminal 设置 |
| GET | `/api/settings/release` | Pi-Ark、bundled pi core、安装状态、路径、命令和 latest release |
| POST | `/api/settings/release/update` | 安装并切换到 latest Pi-Ark release |
| POST | `/api/settings/release/rollback` | 切换到 previous Pi-Ark release |
| POST/GET/DELETE | `/api/settings/subscription-logins...` | OAuth flow start、poll 和 cancel |
| POST | `/api/settings/subscription-logins/:flowId/answer` | OAuth prompt answer |

### Skills 与 MCP

| Method | Path | 用途 |
|---|---|---|
| GET | `/api/skills?workspaceId=` | 返回 `builtin`、`global`、`workspace` 三段 skill 列表与 `diagnostics` |
| PUT | `/api/skills/selection` | 保存 `disabledBuiltin`、`disabledGlobal` 与 `disabledWorkspace`，返回刷新后的列表、`selection` 与 `reloaded` |
| POST | `/api/skills/reload` | 重新加载空闲 Session，返回 `{ reloaded }` |
| GET | `/api/mcp?workspaceId=` | 返回 `servers` 与配置级 `errors` |
| PUT | `/api/mcp/servers/:name/state` | Body 为 `{ enabled: boolean }`，保存 server 启用状态 |
| PUT | `/api/mcp/servers/:name/advanced` | Body 为 `{ enabled: boolean }`，保存 playwright 的高级 capability 开关 |
| GET | `/api/mcp/browser` | 返回浏览器运行时状态、版本、目录与日志 |
| POST | `/api/mcp/install-browser` | 启动 Chromium headless shell 安装并返回当前状态 |

Skills 与 MCP 的列表端点要求 `workspaceId`。MCP server 名称只允许字母、数字、`_` 与 `-`。`PUT /api/mcp/servers/:name/state` 与 `PUT /api/skills/selection` 保存后都会重新加载空闲 Session。

### Session

| Method | Path | 用途 |
|---|---|---|
| GET/POST | `/api/workspaces/:workspaceId/sessions` | List 或 create Session |
| GET | `/api/workspaces/:workspaceId/session-statuses` | 已打开的 Session runtime 状态与 status/update revisions |
| PATCH/DELETE | `/api/workspaces/:workspaceId/sessions/:sessionId` | Metadata/name update 或 delete |
| POST | `/api/workspaces/:workspaceId/sessions/:sessionId/fork` | Fork |
| GET | `/api/workspaces/:workspaceId/sessions/:sessionId/subagents` | 父子关系与任务状态 |
| POST | `/api/workspaces/:workspaceId/sessions/:sessionId/abort` | 停止 Session 及其当前等待的子任务 |
| POST | `/api/workspaces/:workspaceId/sessions/:sessionId/rollback` | Rollback |
| POST | `/api/workspaces/:workspaceId/sessions/:sessionId/rollback/restore` | Restore rollback |
| PATCH | `/api/workspaces/:workspaceId/sessions/:sessionId/queue/:itemId` | Queue reorder/mode，并返回权威 Queue state |
| DELETE | `/api/workspaces/:workspaceId/sessions/:sessionId/queue/:itemId` | 从 Queue 取回 message，并返回 text 与权威 Queue state |
| POST | `/api/workspaces/:workspaceId/sessions/:sessionId/queue/merge-follow-ups` | 按顺序合并全部 Follow-up，并返回权威 Queue state |
| GET/POST | `/api/workspaces/:workspaceId/session-groups` | List 或 create group |
| PATCH/DELETE | `/api/workspaces/:workspaceId/session-groups/:groupId` | Rename 或 delete group |

## WebSocket

### Agent

Path：`/ws/agent/:workspaceId/:sessionId`

可选 query：

- `message`：打开包含指定短 Message ID 的 display window；纯数字值按旧 display position 兼容解析。
- `start`：从指定的全局 message offset 恢复已经加载的 display window。
- `leafEntryId`：展示历史分支，并保持当前活动 leaf；该连接使用历史 snapshot，支持 `load-earlier`。

Browser commands：

- `prompt`
- `load-earlier`
- `abort`
- `rename-session`
- `set-model`
- `set-thinking-level`

Server messages：

- `snapshot`，其中 messages 包含 `messageId`，Session state 包含 `messageNumberOffset`、`totalDisplayMessages`、`targetMessageId`、`hasEarlierMessages` 和 `queueRevision`
- `subagent-state`，其中 `subagents` 包含委派记录、来源与受管状态
- `queue-state`，其中包含 Queue items、`queueRevision` 和可选的 `confirmedOperationId`
- `agent-event`
- `notice`
- `error`
- `session-deleted`

### Terminal

Path：`/ws/terminal/:workspaceId/:terminalId?offset=0`

`offset` 默认为 `0`，表示浏览器已经接收的输出字符串的 UTF-16 长度。Server 校验 Workspace 与 Terminal 的归属，并在连接后发送 `ready`；其中 `data` 从请求的 offset 开始，`offset` 是当前完整输出的 UTF-16 总长度。新输出携带输出后的总长度，浏览器按 offset 接续和去重。

Browser messages：

```ts
{ type: "input", data: string }
{ type: "resize", cols: number, rows: number }
```

Server messages：

```ts
{ type: "ready", terminal: TerminalInfo, data: string, offset: number }
{ type: "output", data: string, offset: number }
{ type: "exit", exitCode: number }
{ type: "closed" }
{ type: "error", message: string }
{ type: "error", code: "INVALID_OFFSET", message: string, offset: number }
```

PTY 自然退出时发送 `exit`，随后继续保留 Tab 和连接；重新连接已退出的 Tab 时，先发送包含历史的 `ready`，再发送 `exit`。显式关闭 Tab 时发送 `closed` 并关闭所有订阅连接。offset 需要是位于历史长度范围内的非负整数；非法请求收到 `INVALID_OFFSET` 和当前总长度，随后连接以关闭码 `1008` 结束。Workspace 或 Terminal 的连接查询失败时，Server 发送 `error`，并使用关闭码 `1008`。

兼容入口 `/ws/terminal/:workspaceId` 和 `openTerminal` 导出继续提供按连接创建的临时 PTY，关闭 socket 时释放该进程。Web 的多 Tab 页面使用包含 Terminal 标识的新入口。

## Release 构建与安装

`npm run release:build` 从 Git checkout 在原生平台构建 release，目标 platform、Node architecture 与主机 architecture 相同。Artifact 包含编译后的 Server/Web、production dependencies、native node-pty、Built-in `skills/` 目录、运行脚本（`pi-ark.mjs`、`install-release.mjs`、`platform.mjs`、`setup.mjs`）和 `RELEASE.json`。

`scripts/release-source.mjs` 在构建前后读取源码 commit 与工作区状态。`RELEASE.json` 的 `sourceCommit` 记录该 commit，`sourceDirty` 记录构建期间的未提交源码状态。构建期间源码 commit 发生变化时，构建报错；正式版本从已提交的源码构建。开发版本可以记录 `sourceDirty: true`，发布准备从 `sourceDirty: false` 的开发 artifact 取得来源。

| 平台 | 原生 runner | Artifact |
|---|---|---|
| Linux x64 | `ubuntu-24.04` | `pi-ark-<version>-linux-x64.tar.gz` |
| Linux arm64 | `ubuntu-24.04-arm` | `pi-ark-<version>-linux-arm64.tar.gz` |
| macOS Intel x64 | `macos-15-intel` | `pi-ark-<version>-darwin-x64.tar.gz` |
| macOS Apple Silicon arm64 | `macos-15` | `pi-ark-<version>-darwin-arm64.tar.gz` |
| Windows x64 | `windows-2022` | `pi-ark-<version>-win32-x64.zip` |

构建脚本在 staging directory 中执行 `npm ci --omit=dev --include=optional`，并在对应 runner 上从源码编译 native dependencies。CI 的开发依赖安装同样使用源码编译，使 PTY 的行为检查与原生安装包使用相同的工具链。Windows 的 runner 使用 Visual Studio 2022 与 Python 3.12，通过 Node 调用 npm 的 JavaScript 入口，通过系统的 tar 创建 zip 并展开 npm workspace junctions。安装包使用方需要 Node.js 22.19 或更新版本；编译所需的 Python 与 C++ 工具属于源码构建环境。Linux 的运行工具为 Bash 与 tar，默认系统安装使用 systemd；portable 使用当前用户的后台管理器。macOS 使用系统 Bash 与 tar，Windows 使用 Git for Windows 的 Git Bash 及系统内置的 PowerShell。

`.github/workflows/release.yml` 在 `main` 或 `release/**` 分支发生 push 时执行原生构建，也支持 `workflow_dispatch`。每个 runner 解压实际 archive 后执行安装 smoke，覆盖带 Unicode 与空格的安装及数据路径、setup、HTTPS 登录、Files 预览与下载、Session API、PTY 命令输出、后台 start/restart/stop、重启后的认证保持、release rollback 和数据保留。该 runner 完成 smoke 后上传可发布的 archive。`check-ci-command.mjs` 保存各个命令的输出到 `dist/native-ci/`，失败时生成包含错误内容的 Actions annotation，并将同一目录中的日志上传为诊断 artifact。每个命令默认在 10 分钟后超时，超时摘要保留最后的输出，随后停止该命令的进程树；`PI_ARK_CI_COMMAND_TIMEOUT_MS` 可以调整该时长。

### 正式发布的编排

`scripts/release-process.mjs` 提供 `release:prepare`、`release:status` 与 `release:publish` 的源码命令入口。`prepare` 默认从 systemd MainPID 及其子进程定位 `pi-ark-dev.service` 的实际 Server，并根据 `/proc/<pid>/cmdline` 中的 Server 入口读取对应的 `RELEASE.json`，随后再次确认读取期间的 service 与 Server 进程一致。它使用 artifact 的 `sourceCommit`，并核对该 commit 的 package 版本与实际运行版本。`--source <Git ref>` 表示发布负责人确认的已提交源码。实例安装目录与 service unit 可以通过 `--prefix` 和 `--service-name` 指定。

每个正式版本的状态保存在 `.tmp/release-process/<version>/state.json`，候选源码位于该目录下的 `source` Git worktree，Git 操作的临时目录位于 `tmp`。状态包含来源记录、固定的 source commit、release commit、分支与工作区。命令锁协调同一版本的准备和发布操作。`prepare` 在 `release/<version>` 分支更新项目与 workspace 的 package/lock 版本，再提交并推送候选。共享开发工作区保留当前的内容。

候选需要修正时，`prepare --source <Git ref> --refresh` 使用新的已确认源码。候选 tree 等于新来源加 package 版本更新，后续的 merge commit 使用旧候选作为第一 parent，使用新来源作为第二 parent，并通过 `Pi-Ark-Source` trailer 记录来源。候选分支的 push 会携带来源 commit，其他 checkout 可以从该分支恢复来源。`pendingSource` 保存更新期间的来源与候选状态，完成后将旧记录保存在 `previous` 中。重复执行可以恢复 commit 或 push 中断；状态文件丢失时，命令从候选分支与来源 trailer 恢复记录。正式 tag 创建后，该版本继续沿用已发布的来源。

`status` 通过 GitHub API 显示候选或正式 tag 的 run、job 和步骤，失败时读取 `Native CI command failed` annotation；`--watch` 在有 API token 时默认每 30 秒查询，匿名查询时默认每 180 秒查询，以适应公共 API 的查询频率。Git push 沿用当前 Git 配置，GitHub API 使用可选的 `GH_TOKEN` 或 `GITHUB_TOKEN`。正式发布的完成状态还会核对 Release 类型、tag 与完整的非空安装包清单。

`scripts/release-candidate.mjs` 供源码命令和 tag workflow 共用。候选须来自 `release/<version>` 分支的成功 push run，run 的 commit 和源码 package 版本须与目标一致，所需的平台 artifacts 须完整且处于保留期。`publish` 确认候选后创建并推送 annotated `v<version>` tag。Tag workflow 按候选 run ID 和 artifact IDs 下载安装包，核对对应版本的归档文件名，再通过 `contents: write` 与 `actions: read` 权限发布 GitHub Release。已完整交付的同 commit 版本可以再次确认。

实例管理员在正式 Release 完成后通过现有的 `update`、安装器和 `rollback` 执行上线或恢复，运行实例的安装状态与发布工作区分别保存。

### Linux 系统安装

System installer 默认使用以下布局：

```text
/opt/pi-ark/
  current -> releases/<version>
  previous -> releases/<previous-version>
  releases/<version>/
  install.json
  bin/pi-ark.mjs
  bin/platform.mjs
  bin/pi-ark
  bin/pi-ark.cmd
/var/lib/pi-ark/
  config.json
  auth-sessions.json
  tls/
  pi-agent/
/etc/systemd/system/pi-ark.service
/usr/local/bin/pi-ark
```

Installer 默认创建专用的 `pi-ark` service account。`--migrate-data` 可以复制现有 Global data 并更新其中指向旧 data directory 的 TLS paths。Linux 系统安装在完成 release preflight 后生成最终的候选 unit，将其写入 `<prefix>/.unit-check-*/<service-name>` 并执行 `systemd-analyze verify`，检查完成后清理候选目录；候选验证通过后才切换版本并写入真实 unit。`WorkingDirectory` 使用直接的绝对路径，并将 `%` 转义为 `%%`；`ExecStart` 参数与 `Environment` 值分别使用 systemd 的带引号语法。安装器在 `daemon-reload` 后确认 `LoadState=loaded`，然后执行所选的启动安排。systemd 在每次启动前执行 release preflight，并通过稳定 CLI 的 `serve` 命令运行 supervisor；supervisor 从 `current` 启动 Server，并处理 release 切换后的健康检查与恢复。

### 当前用户安装与后台管理

macOS 与 Windows 默认使用 portable，Linux 通过 `--portable` 选择该模式。

| 平台 | 默认 prefix | 默认 data directory |
|---|---|---|
| macOS | `~/Library/Application Support/Pi-Ark/app` | `~/Library/Application Support/Pi-Ark/data` |
| Windows | `%LOCALAPPDATA%\Pi-Ark\app` | `%LOCALAPPDATA%\Pi-Ark\data` |
| Linux portable | `~/.local/share/pi-ark` | `~/.pi-ark` |

非 default instance 的应用目录名称使用 `-<instance>` 后缀，例如 `Pi-Ark-dev` 或 `pi-ark-dev`。Portable 使用当前用户的权限，并在关闭启动终端后继续运行。

`scripts/platform.mjs` 负责平台默认路径、archive 名称与解压、release staging、release state 和 HTTPS health request。POSIX 将 `current` 与 `previous` 保存为 symlink；Windows 将二者的绝对路径保存到 `<prefix>/release-state.json`；并发读取造成短暂的替换占用时，写入流程在 5 秒内重试原子 rename。`<prefix>/install.json` 记录安装模式、Node 路径、instance、data directory 和 CLI environment。

安装器在 `<prefix>/bin/` 中创建稳定的 `pi-ark.mjs` 与配套的平台模块，另提供 POSIX launcher 和 Windows `.cmd`。非 default instance 使用对应的 CLI 名称。稳定入口加载安装时的环境和当前 release；用户可以使用完整的 Node 调用路径，或自行将该目录加入 PATH。

`start` 创建 detached 后台管理器，并将输出写入 `<prefix>/logs/pi-ark.log`。管理器在 `<prefix>/run/daemon.json` 中保存自身状态，使用带随机 token 的 loopback HTTP control channel 接收 status 与 stop。命令锁串行执行 start/stop/restart。`status` 返回运行路径和 health 等信息，`logs` 输出日志，`logs --follow` 持续读取新增内容。`stop` 请求管理器停止 Server 并清理运行状态，`restart` 先停止再启动。`serve` 保持前台运行。

### 初始化与多实例

Setup 通过 production dependency `selfsigned@5.5.0` 生成 RSA 3072-bit、825 天有效期的自签名 TLS certificate，SAN 为 `localhost` 与 `127.0.0.1`；private key 与 certificate 保存在 `PI_ARK_HOME/tls/`。登录信息可通过原有 setup 参数或 `PI_ARK_USERNAME` 与 `PI_ARK_PASSWORD` 环境变量提供。

Multi-instance installation 通过 `PI_ARK_INSTANCE`、`PI_ARK_BASE_PATH`、`PI_ARK_SERVICE_NAME` 和 `PI_ARK_CLI_NAME` 描述当前实例。Installer 为非 default instance 生成 instance-aware CLI launcher，并在 Linux 系统安装中生成独立的 service unit。`--port` 更新已有 listen port，并保存后续 setup 的默认端口；Linux 系统安装的 `--deferred-restart` 在完成候选 unit 验证和加载状态确认后创建 transient systemd timer，将重启安排在安装器返回之后。自替换的安装包预先在独立配置与数据目录中完成启动、health 与版本确认；当前 Agent 在登记 timer 后报告重启前的确认结果并结束本轮操作，服务随后重启。重启后的检查可以由用户或后续独立 Session 执行。

Frontend 从 `document.baseURI` 推导 base path。所有 API、WebSocket、Files image 和 download URL 都经过同一个 base-path helper；Vite build 使用 relative asset URL。Nginx 在 public URL 上保留 base path，并通过带末尾 `/` 的 `proxy_pass` 将该前缀移除后发送给 Fastify。Fastify 的内部 routes 继续使用 `/api` 与 `/ws`。

Auth cookie name 包含 `PI_ARK_INSTANCE`，cookie Path 对应 `PI_ARK_BASE_PATH`。同一个 hostname 下的实例不会互相覆盖 auth cookie。各实例使用独立的 Global data 与 pi agent data；Workspace `.pi-ark` state 可以共享。同一个 Session 由一个实例执行写操作。

## Static assets 与 URL fallback

Server 从 `apps/web/dist` 读取 Web assets。带 hash 的文件使用一年 immutable cache，其他文件使用 `no-cache`。不存在扩展名的路径返回 `index.html`，支持浏览器页面刷新；不存在的带扩展名路径返回 404。

## 安全说明

- TLS key、credential、password hash 和 Workspace state 应由服务账号管理。
- Auth session 以 token 哈希保存在 `PI_ARK_HOME/auth-sessions.json`，服务重启后浏览器已有登录继续有效；Logout 和密码变更会使对应 session 失效。
- API 和 WebSocket 共用认证 hook。
- File API 使用 realpath 防止相对路径和 symlink 离开 Workspace；图片与下载 stream 从已打开并再次核对 Workspace 边界的 file descriptor 读取。
- `.pi-ark` state 无法通过 Files API 读取。
- Attachment filename 会清理，并在 Session directory 中添加随机前缀。
- HTML Markdown 使用 DOMPurify 清理。
- Terminal 与 Agent tools 拥有服务进程的系统权限。
- Workspace path 是产品范围，不是操作系统权限隔离。
- 当前生产服务应使用权限明确的专用系统账号，并只注册该账号需要访问的目录。

## 构建与检查

```bash
npm run build
npm run check
npm run check:behavior
npm run check:setup
npm run check:platform
npm run check:file-links
npm run check:file-links-ui
npm run check:release-process
npm run check:release -- "path/to/extracted-artifact"
npm run check:subagents
npm run check:subagents-ui
npm run check:ui
npm run check:markdown-ui
npm run check:terminal
npm run check:terminal-appearance
npm run check:terminal-ui
npm run release:build
```

`check:release-process` 使用隔离 Git repository、bare remote 和受控的 GitHub API 响应，检查构建来源、候选准备、源码修正、中断恢复、tag 冲突、候选安装包复用和正式交付清单；该命令包含在 `check:behavior` 中。

`check:setup` 检查 setup 的参数与环境变量、TLS certificate、密码摘要与 HTTPS。`check:platform` 检查平台默认路径、release state、staging 与路径迁移。`check:release -- <artifact-dir>` 使用解压后的原生 artifact 执行 portable 安装 smoke，并确认服务重启后已有 auth cookie 仍有效；设置 `PI_ARK_SMOKE_ROLLBACK=1` 后还会覆盖版本切换与 rollback 的数据保留，Release workflow 使用该设置。

`check:subagents` 使用真实 SDK Session 与受控模型响应，覆盖并发限制、图片引用、结果截取、历史分支、停止、删除、恢复与工具注册。`check:subagents-ui` 构建项目，并自动创建临时 HTTPS 实例，使用临时数据目录与独立端口执行任务面板和双向导航的 Chromium 检查。设置 `PI_ARK_CHECK_FULL_UI=1` 后，该临时实例还会执行现有的 `check:ui` 脚本。

`check:file-links` 覆盖路径解析、文件访问规则、分片识别、队列去重、内存缓存、持久化确认结果的装载与有效期以及取消。`check:file-links-ui` 使用独立实例检查原文首显、延迟确认期间的输入响应、文件及目录跳转、相对链接、刷新、新标签页与长消息的批量处理。

`check:markdown-ui` 使用 `PI_ARK_CHECK_URL` 与 `PI_ARK_CHECK_WORKSPACE` 指定的临时 HTTPS 实例和独立 Workspace，检查 Keep line breaks 的默认值、保存与刷新，以及会话正文、Reasoning 和 Markdown 文件预览中的换行、段落、代码块、列表和表格。

`check:terminal` 将对应的服务源码转为 JavaScript，再以独立 Node 进程使用临时配置与实际 PTY；该进程沿用安装版的 helper 启动方式，并在超时后清理进程树。该检查覆盖 Terminal 默认配置、合法与非法设置、旧 preferences 保存、跨平台 shell 解析、中文输入输出、多 Tab 隔离、断连继续运行、offset 增量回放、自然退出保留与关闭清理；该脚本也包含在 `check:behavior` 中。`check:terminal-appearance` 检查字体默认值、历史默认列表迁移、自定义字体、偏好事件与存储失败时的行为。`check:terminal-ui` 使用 `PI_ARK_CHECK_URL` 和 `PI_ARK_CHECK_WORKSPACE` 指定的独立 HTTPS 实例与工作目录，创建检查所需的临时 Workspace，并检查 Terminal 的浏览器交互。Terminal、Settings、Markdown 与完整 UI 检查的截图默认写入项目的 `.tmp/`，也可通过 `PI_ARK_CHECK_SCREENSHOT_DIR` 指定截图目录。

Behavior scripts 覆盖 conversation segmentation、Session snapshot/UI state LRU 与清理、Server display pagination、active Session Fork、attachments、OAuth flow、模型偏好与 credential 断开、Session actions、system prompt、Workspace Files schema、preview 和 download metadata。Chromium script 覆盖主要页面交互、dialog、rollback、permalink、首次 loading snapshot、缓存 Session 的即时显示与后台更新、刷新后的 IndexedDB draft/attachment/disclosure 恢复、Browser cache 清理、dark theme fold contrast、earlier message 加载、tool details、interrupted warning、Files 图片/超限下载、模型 checkbox/default 和 Settings 自动保存。
