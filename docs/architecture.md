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
scripts/            初始化、CLI 和行为检查
docs/               产品、架构、使用和集成文档
```

根 `package.json` 使用 npm workspaces 管理 `apps/*`。正式构建先生成 Web assets，再编译 Server；Server 从 `apps/web/dist` 提供静态文件。

## 服务启动

`apps/server/src/index.ts` 执行以下启动顺序：

1. 根据 `PI_ARK_HOME` 和 `PI_ARK_AGENT_DIR` 初始化 Pi-Ark 专用的 pi agent data directory。
2. 将 `PI_CODING_AGENT_DIR` 指向该专用目录，使 pi SDK 使用相同的 settings、credential 和 resource files。
3. 读取 Global config 与 TLS key/certificate。
4. 创建 HTTPS Fastify service；HTTP request body 上限为 1 MB，WebSocket payload 上限为 28 MB。
5. 创建 Auth、Workspace、Settings、Pi-Ark release、OAuth flow 和 Agent services。
6. 注册 HTTP routes、Agent WebSocket 和 Terminal WebSocket。
7. 注册静态 Web asset fallback。
8. 监听配置的 HTTPS 地址。

收到 SIGINT 或 SIGTERM 时，Server 先释放 Agent runtime，再关闭 Fastify。

## Server 模块

| 模块 | 文件 | 职责 |
|---|---|---|
| Server composition | `apps/server/src/index.ts` | 启动、认证 hook、HTTP/WebSocket routes、静态资源和 shutdown |
| Global config | `apps/server/src/config.ts` | 配置解析、data directory、共享 preferences 和串行原子写入 |
| Authentication | `apps/server/src/auth.ts` | scrypt password、内存 session token 和 cookie |
| Workspace and Files | `apps/server/src/workspaces.ts` | Workspace registry、目录建议、安全路径、文本与图片预览和文件下载 |
| Agent runtime | `apps/server/src/agents.ts` | pi Session 生命周期、snapshot、queue、fork、rollback、attachments、自带工具注册和广播 |
| Internal links | `apps/server/src/internal-links.ts` | Web 与 Server 共用的 Workspace、Session 和 Message 内部链接解析与生成 |
| Session display | `apps/server/src/session-display.ts` | 完整活动分支的 display projection、短 Message ID、Compact 统计和旧数字目标的定位 |
| Compact statistics | `apps/server/src/compaction-stats.ts` | 按压缩时的 projection 估算上下文组成，并关联压缩耗时 |
| Session reader | `apps/server/src/session-reader.ts` | Workspace 摘要、Session 分页、Message 定位、前后文和长内容续读 |
| Pi-Ark link tool | `apps/server/src/agent-tools/read-pi-ark-link.ts` | `read_pi_ark_link` 的参数、输出 schema、说明和执行入口 |
| Attachments | `apps/server/src/attachments.ts` | 限额检查、文件名清理、保存和 image content 转换 |
| Session metadata | `apps/server/src/session-metadata.ts` | Pin、Archive、group 和串行原子写入 |
| Workspace Notebook | `apps/server/src/workspace-notebook.ts` | Workspace 临时笔记的读取与串行原子写入 |
| Global settings | `apps/server/src/settings.ts` | Provider、model、thinking、queue、compaction、retry 和 credential login |
| OAuth flow | `apps/server/src/auth-flows.ts` | Subscription login 的事件、prompt、answer 和 cancel 状态 |
| Pi-Ark release | `apps/server/src/pi-core.ts` | Pi-Ark 与 bundled pi core 版本信息、GitHub Releases 查询、完整 release 更新、回退和延迟重启 |
| Terminal | `apps/server/src/terminal.ts` | node-pty、input/output、resize 和 process exit |

## Web 模块

| 模块 | 文件 | 职责 |
|---|---|---|
| Application shell | `apps/web/src/App.tsx` | Auth 状态、Workspace/Session 选择、页面导航、URL 和响应式侧栏 |
| Agent page | `apps/web/src/components/Chat.tsx` | WebSocket snapshot、message renderer、composer、queue、fork 和 rollback |
| Session memory cache | `apps/web/src/session-cache.ts` | 最近五个 Session 的 snapshot 与 UI state 浏览器内存 LRU cache |
| Session status projection | `apps/web/src/session-status.ts` | 合并 runtime revision、计算 unread output 和记录当前浏览器的查看状态 |
| Conversation segmentation | `apps/web/src/conversation.ts` | Turn 分段、tool run collapse 和 interrupted warning |
| Workspace list | `apps/web/src/components/WorkspaceList.tsx` | 选择、重命名和关闭 Workspace |
| Session list | `apps/web/src/components/SessionList.tsx` | 单行 Session、更新时间 tooltip、Notebook 入口、groups 和 Archived 区域 |
| Notebook | `apps/web/src/components/Notebook.tsx` | Workspace 笔记加载、debounce 自动保存和保存状态 |
| Files | `apps/web/src/components/Files.tsx` | 全宽目录导航、可调整的文件列表、path copy、文本阅读和 Markdown image path |
| Markdown | `apps/web/src/components/Markdown.tsx` | marked、DOMPurify、链接和图片展示 |
| Terminal | `apps/web/src/components/Terminal.tsx` | xterm.js、FitAddon 和 Terminal WebSocket |
| Settings | `apps/web/src/components/Settings.tsx` | 按功能类别展示 Global settings，保留页面状态，并按需加载 prompt preview 与 release 信息 |
| API client | `apps/web/src/api.ts` | HTTP request、error mapping 和 WebSocket URL |
| Permalinks | `apps/web/src/permalinks.ts` | Browser URL 与 `pi-ark://` link 的生成和解析 |
| Theme | `apps/web/src/theme.ts` | Theme metadata、应用和本地初始化 |

Files、Terminal 和 Settings 使用 React lazy loading。Chat 保持在主 bundle 中，Session 切换时可以立即建立 WebSocket。

## Authentication

Password 使用 scrypt 保存为 `scrypt$salt$digest`。登录成功后，AuthService 生成随机 token，并在内存 Map 中记录 24 小时有效期。

Cookie 属性如下：

- `HttpOnly`
- `Secure`
- `SameSite=Strict`
- Path `/`
- Max-Age 24 小时

每次成功认证的请求会延长内存有效期。服务进程重启会清空登录 session，浏览器需要重新登录。

Fastify `onRequest` hook 保护所有 `/api/` 和 `/ws/` 路径；health 和 login routes 保持公开。WebSocket upgrade 使用相同的 cookie 认证。

## Workspace 与文件边界

Global config 中的 Workspace registry 是浏览器可以访问的目录清单。Add workspace 执行以下检查：

- 输入是绝对路径。
- `realpath` 可以解析。
- 路径是目录。
- 同一个真实目录尚未注册。

文件读取先将 Workspace path 和请求 path 解析为 `realpath`，再检查结果仍位于 Workspace 内。包含 `.pi-ark` path segment 的请求会被拒绝；目录列表也始终过滤该目录。

文本、Markdown 和图片共用 Workspace 的 `files.maxPreviewSizeMb` 预览上限。默认值是 10 MB，保存范围是 1–100 MB；包含 NUL byte 的 binary file 不进入文本预览。PNG、JPEG、GIF 和 WebP 可以作为选中文件或 Markdown image 预览。下载 endpoint 使用 stream 返回原始文件，不受预览大小和文件类型限制。

Directory suggestions 只返回服务账号可以读取的目录和直接子目录，每次最多返回 100 个结果。

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

新 Session 使用 `SessionManager.create(workspace.path, sessionDir)`。恢复使用 `SessionManager.open(jsonlPath, sessionDir)`。Workspace session directory 固定为 `<workspace>/.pi-ark/sessions/`。

创建 AgentSession 时，AgentService 加载以下输入：

- Workspace cwd。
- Global 启用的 tools，以及 Pi-Ark 自带的 `read_pi_ark_link`。
- Pi-Ark agent directory 中的 Global resources。
- Global system prompt append。
- 已有 SessionManager。
- `enabledModels` 解析出的 scoped models。

新 Session 使用已勾选模型中的 Global default；Global default 不在当前 scope 中时，使用 scope 中的第一个模型。恢复已有 Session 时，pi SDK 优先恢复 Session JSONL 记录的当前模型，scoped models 用于后续模型选择。

### Pi-Ark link 读取工具

`AgentService` 接收当前 `WorkspaceService` registry，并在创建和恢复 AgentSession 时通过 `createAgentSession({ customTools })` 注册 `read_pi_ark_link`。显式 `tools` 列表包含该名称，使工具始终与 Global 所选的文件工具一起可用。Global effective system prompt preview 使用同一份工具定义。工具提供 `description`、`promptSnippet` 和 `promptGuidelines`，引导 Agent 使用工具读取用户提供的内部链接。

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

成功结果以 JSON text 和符合 `outputSchema` 的 `structuredContent` 返回。结果包含 Workspace、Session、target、messages 或 Session 摘要、pagination 和 `truncated`。每条消息包含短 Message ID、source entry ID、当前 display position、内部链接、role、timestamp 和可用的 model 或 tool 信息。正文按顺序保留文本、reasoning、tool call arguments、tool result 和 summary；图片表示为 MIME type 占位说明。消息的 `contentOffset`、`totalContentCharacters` 和 `nextContentOffset` 支持完整续读。

单次序列化的结果最多为 48 KiB。Message 加前后文时优先为目标分配正文空间，结果仍按 display position 排列。部分消息提供 `nextContentOffset`；`pagination.nextStart` 指向后续条目，调用方使用 Session 或 Workspace link 继续分页。`INVALID_LINK`、`UNKNOWN_WORKSPACE`、`UNKNOWN_SESSION`、`MESSAGE_NOT_FOUND`、`INVALID_ARGUMENT`、`PAGE_OUT_OF_RANGE` 和 `CONTENT_OUT_OF_RANGE` 区分链接与读取错误。工具支持 AbortSignal，并声明读取性质的 annotations。

### Snapshot

连接成功后，Server 立即发送 snapshot。Snapshot message 来源是当前活动 branch 的 display projection；每条持久化 message 附加短 Message ID 和 source entry ID，assistant message 还附加 model context window。普通连接从最新约 100 条 messages 所在的 turn boundary 开始发送。带 `message` query 的 permalink 连接从包含目标 Message ID 的页面开始发送；带 `start` query 的缓存恢复连接从浏览器已经加载的全局 offset 开始发送。

Snapshot 包含以下状态：

- Session ID 和名称。
- 当前 client display window 的 messages。
- `messageNumberOffset`、`totalDisplayMessages`、`targetMessageId` 和 `hasEarlierMessages`。
- Streaming 和 idle 状态。
- 当前 model 和 thinking level。
- 可用 thinking levels。
- Queue。
- Rollback 和 restore 状态。
- Session statistics。

首次打开且浏览器没有内存 cache 时，Web 将首个 snapshot 作为加载完成依据。Socket open 只表示连接成功。切回最近查看的 Session 时，Web 先显示最多五个 Session 的内存 LRU snapshot，再连接 Server，并以权威 snapshot 更新 cache。

同一模块还保存最多五个 Session 的 memory-only UI state，包括 composer draft、待发送 attachments 和 conversation disclosures。Disclosure key 使用 source entry ID、tool call ID 或 run 中首条 source entry ID，因此 Server snapshot 更新和 earlier-message pagination 不改变该 identity。Session 删除或 UI cache 淘汰时，Web 释放对应 attachment preview object URLs。发送或手动移除 attachment 时也立即释放 preview。该 cache 不写入 localStorage，浏览器刷新后重新从 Server 加载。

### Streaming events

AgentSession subscription 将 pi events 通过 `agent-event` 转发给所有 clients。Web 使用 message start/update/end 更新流式内容，并从 agent start 到 agent settled 保持 active run 状态。pi 在 public `message_end` listener 返回后将 completed message 写入 SessionManager，因此 Server 在下一次 task 中调度 message end、agent settled 和 queue update 后的权威 snapshot。该时序使 snapshot 包含刚完成持久化的 message。Server 为每个 client 保留 display window 起点，并只发送该起点到最新 message 的 projection slice；Agent runtime 继续使用 pi 的 compaction-aware Session projection 生成后续模型上下文。

### Sidebar Session status

`GET /api/workspaces/:workspaceId/session-statuses` 只读取当前 Server process 中已经打开的 AgentHandle，不扫描 Session JSONL。Web 每秒读取该轻量状态列表。每条状态包含 `ready`、`running` 或 `error`、单调递增的 `statusRevision`、完成态使用的 `updateRevision`，以及可选的 error message。

`agent_start` 将状态切换为 `running`。`agent_end` 只记录最终且不再 retry 的 assistant error；`agent_settled` 才将状态切换为 `ready` 或 `error`，因此单条 `message_end` 不会提前结束 spinner。Aborted run 返回 `ready`，但不递增 `updateRevision`。Prompt 在 Agent run 建立前直接失败时，Server 立即进入 `error` 并递增 completed update revision。

Web 将最后收到的 revision 保存在当前页面内存中。较旧的 response 不覆盖较新的状态。Session 的 `updateRevision` 增加且进入 `ready` 时，Web 显示 unread output；首次收到已有 completed revision 的 Session 也会显示 unread output。浏览器在可见的 Agent 页面打开该 Session 后清除 unread 标记。Web 按 Workspace 保存这份内存状态，因此切换 Workspace 后返回仍可看到尚未查看的新输出。Error 由 Server runtime state 决定，打开 Session 不会清除 error；下一次 Agent run 会更新该状态。该查看状态不写入 localStorage，也不写入 Session JSONL。

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
- Active turn 将截至最新 tool activity 的连续过程放入带 Running 状态的 run collapse，并在外部保留后续的非工具 assistant output；没有保存状态时，`RunCollapse` 在 active 状态开始时默认展开，其中的 tool details 默认关闭。用户手动改变的 Run、Tool、Reasoning 和 Message Info disclosure 状态写入当前 Session 的 UI memory cache，并在切换 Session 后恢复。
- 已完成 tool turn 将最后一条非工具 assistant output 之前的过程放入 run collapse；`RunCollapse` 观察 active→completed 转换并自动折叠并更新缓存状态。已完成的 permalink target 在没有已有用户状态时自动展开对应 details。
- Idle 且缺少最后一条非工具 assistant output 的 tool turn 将全部过程放入 run collapse，并追加 warning segment。

Turn renderer 在 segment 渲染前扫描当前页面的 projection messages，并通过 `toolCall.id` 与 tool result 的 `toolCallId` 建立 call/result 对应关系。Renderer 随后按每条 source message 的 content block 顺序生成 text 与 tool feed items。Text item 处理 text、image 和 reasoning；reasoning 使用较小字号与和普通 text 一致的行高。App 从 `/api/ui` 读取 Global `hideReasoning`，并传给 Chat renderer；启用后 renderer 跳过 thinking block 的 DOM 输出，Server snapshot、Session JSONL 和 model context 保持原内容。tool call 与 result 合并成单行折叠项，tool logo 位于 details summary 内，使展开内容与 details 左边界对齐。Completed 使用中性色；Running、Failed、Result 和 Saved 分别使用 theme 的 warning、danger、info 和 saved colors，并且只改变同一层 details 的 border、logo 与 status text。Tool permalink target 使用 details 内侧的 accent 标识，不增加外层 padding、背景或包围框。每个 theme 分别提供 Run palette 与 Tool palette：Run group 使用该 theme 的 tint surface，Tool row 和 Reasoning 使用更中性的 surface，并具有独立的 open surface 与 border color。Paper 的 Run group 使用低饱和 sage-gray tint，Tool row 使用浅白色；dark themes 和 Snow 使用对应 accent 倾向的外层 Run surface 与更亮的中性 Tool surface。Compact 与 branch summary 也使用 tool feed item。Compact 的收起高度为普通 tool row 的 3 倍，并展示压缩前后的用量、估算的上下文组成和压缩耗时。展开 tool item 后先显示 Call/Result 的消息 link 按钮，整段按钮包含 source Message ID 与复制图标；tooltip 使用 portal 到 document body 的 fixed 浮层。短 Message ID 在 User header、sticky User 与 source link 中统一使用斜体。其后显示 arguments、result 或 summary。`buildToolCallGroups()` 在已配对结果的基础上，按连续的 tool-only assistant messages 分组。正文、图片、Reasoning、Compact、branch summary 与独立结果会中断分组；包含正文的 message 中的 tool calls 保持原有显示。`ToolCallSequence` 按单个 call 计数，默认隐藏较早调用并保留最后 3 个，使用 `show more tool call` / `show less tool call` 切换。分组使用首个 source message 与 call 的稳定标识保存 disclosure；早期 message 或 result 的 permalink target 在首次访问时展开分组。Arguments renderer 按顶层 key 分组，使用 heading 样式显示 key，并在下一行显示格式化 value；嵌套 object/array 使用无 JSON braces 和 quotes 的缩进文本。

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

### Global settings

SettingsService 使用 pi 的 SettingsManager 和 ModelRuntime。Global settings 分布在以下文件：

- Theme、reasoning visibility、Workspace registry 和共享 `preferences`（Agent tools、Global prompt append 和 Files preferences）：`PI_ARK_HOME/config.json`。
- Enabled models、default provider/model/thinking、queue modes、compaction 和 retry：`PI_ARK_AGENT_DIR/settings.json`。
- Credentials：`PI_ARK_AGENT_DIR/auth.json`。
- Custom models：`PI_ARK_AGENT_DIR/models.json`。

API key 通过 `ModelRuntime.login(provider, "api_key", interaction)` 写入。保存 credential 的断开操作调用 `ModelRuntime.logout(provider)`。Settings response 返回 credential 状态、来源和是否可以断开；credential 内容保留在服务端。

模型 checkbox 使用 `SettingsManager.getEnabledModels()/setEnabledModels()`。SettingsService 通过 pi 的 `resolveModelScopeWithDiagnostics()` 解析 exact reference、glob 和 thinking suffix；Session model API、模型切换校验和新 Session 创建使用同一 scope。全部当前可用模型均勾选时，Pi-Ark 将 `enabledModels` 保存为 `undefined`，沿用 pi 的“全部可用模型”语义。模型偏好保存要求至少一个当前可用模型，并要求 default 属于已勾选模型。

断开 Provider 后，SettingsService 从断开前的已勾选模型中保留仍可用的模型。没有剩余已勾选模型且还有其他可用模型时，SettingsService 选择第一个可用模型，并同步 default 与 thinking level。

### Subscription OAuth

Provider 的 `auth.oauth.isSubscription` 决定 UI 是否显示 subscription login。AuthFlowService 将 pi OAuth interaction 转换为可轮询状态，支持 info、auth URL、device code、progress、text/secret/manual code prompt、select prompt 和 cancel。

SettingsService 调用 `ModelRuntime.login(provider, "oauth", interaction, { getDeviceId })`。`getDeviceId` 使用 `SettingsManager.getOrCreateDeviceId()`，首次需要时生成 UUID，并将稳定的安装实例标识保存到 `PI_ARK_AGENT_DIR/settings.json`。OpenAI 的 ChatGPT subscription 登录使用该全局值作为 agent host ID。

Flow、events 和待回答 prompt 保存在服务内存中。每个 Provider 同时保留一个 pending flow；启动同一个 Provider 的新登录时，AuthFlowService 会取消此前的 pending flow，使 OAuth callback listener 和 ModelRuntime credential 操作可以释放。不同 Provider 的登录 flow 可以同时进行。Flow event 最多保留最近 50 条。

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
      "tools": ["read", "bash", "edit", "write"],
      "systemPrompt": { "append": "" }
    },
    "files": { "showHiddenFiles": true, "maxPreviewSizeMb": 10 }
  }
}
```

缺少 preferences 的既有 Global config 使用以上默认值。所有 Workspace 使用同一份配置；历史 `<workspace>/.pi-ark/config.json` 保留为历史数据，当前实现从 Global 取得工具、提示词和文件偏好。`ensureWorkspaceState()` 创建 Session directory。Preferences PUT 更新 tools 与 files，system prompt PUT 更新 append；二者共享 Global config 的串行原子写入，并保留其他字段。

### Settings 的页面缓存

Settings 首次访问后保持挂载，并使用独立的 Suspense 容器，与 Files 和 Terminal 的 lazy loading 分开。切换页面时隐藏 Settings 的 DOM，保留已加载数据、所选类别、提示词草稿、disclosure 和各类别的滚动位置。该状态位于当前页面内存中。Global settings 与模型清单独立加载，首屏以 Global settings 为依据；prompt preview 在展开时加载，release 信息在首次进入 Maintenance 时加载。Refresh settings 主动取得最新数据。离开页面时清空尚未提交的 API key，并暂停 subscription 轮询。

### Pi-Ark release 管理

Release manager 从 release 目录的 `RELEASE.json` 读取 Pi-Ark 与 bundled pi core 版本，并通过 GitHub Releases API 查询 stable channel。开发 checkout 没有 `RELEASE.json`，因此只提供版本和路径信息。

Instance-aware CLI 的 `update` command 执行以下流程：

1. 查询 GitHub 的 latest release，并选择当前 Linux architecture 对应的 artifact。
2. 下载并解压到临时目录。
3. 检查 `RELEASE.json`、必要的 Server/Web 文件、pi SDK import 和 node-pty native module。
4. 将 release 复制到 `PI_ARK_INSTALL_PREFIX/releases/<version>`。
5. 保存当前 release 为 `previous`，再通过临时 symlink rename 原子切换 `current`。
6. Web update API 在返回响应后向当前进程发送 `SIGTERM`；现有 shutdown handler 关闭 Agent runtime、WebSocket 和 Fastify，systemd 再根据 `Restart=always` 从新的 `current` 启动。
7. CLI service supervisor 请求新进程的 `/api/health`；30 秒内无法通过时，它恢复 previous release，并让 systemd 再次启动。

Instance-aware CLI 的 `rollback` command 对调 `current` 与 `previous`，写入 pending release state，并使用相同的健康检查与延迟重启流程。Global data 和 Workspace data 位于 release 目录之外，因此更新与回退不会改写这些数据。

日常迭代使用 `<next-version>-dev.<iteration>` SemVer prerelease。开发 artifact 安装到本机 `/opt/pi-ark-dev/releases/<dev-version>`，并通过同一套 preflight、symlink 和 systemd 流程运行；该流程不会创建 Git tag 或 GitHub Release。正式 release 需要明确的发布安排。

## 数据存储

### Global data

| 路径 | 内容 |
|---|---|
| `PI_ARK_HOME/config.json` | Listen、TLS、auth hash、Workspace registry、theme、reasoning visibility 和共享 preferences |
| `PI_ARK_HOME/tls/` | Setup 生成的 TLS key 和 certificate |
| `PI_ARK_AGENT_DIR/auth.json` | pi provider credentials |
| `PI_ARK_AGENT_DIR/settings.json` | pi Global defaults |
| `PI_ARK_AGENT_DIR/models.json` | Custom provider/model config |
| `PI_ARK_AGENT_DIR/SYSTEM.md` | 可选 Global replacement prompt |
| `PI_ARK_AGENT_DIR/APPEND_SYSTEM.md` | 可选 Global append prompt |

### Workspace data

| 路径 | 内容 |
|---|---|
| `<workspace>/.pi-ark/sessions/*.jsonl` | pi session tree |
| `<workspace>/.pi-ark/notebook.md` | Workspace Notebook 的 UTF-8 Markdown 文本 |
| `<workspace>/.pi-ark/sessions-meta.json` | Pin、Archive、groups 和 group definitions |
| `<workspace>/.pi-ark/attachments/<session>/` | Session attachments |

Global config、Session metadata 和 Workspace Notebook 使用 temporary file 加 rename 的方式写入。Global config 使用服务进程级 write queue，Session metadata 按 Workspace 使用 write queue，Notebook 按目标文件使用 write queue。Web Notebook 在输入停止约 300 ms 后保存，并在 blur 或页面卸载时提交尚未保存的内容；同一页面的请求通过 Promise chain 按编辑顺序发送。

### Browser-local preferences

浏览器 localStorage 保存侧栏状态和宽度、Workspace 展开状态、conversation width、Files 文件列表宽度和最近应用的 theme。`pi-ark-files-browser-width` 保存桌面 Files separator 调整后的文件列表宽度；移动端的上下堆叠布局不使用该宽度。

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
| GET/PUT | `/api/ui` | 读取或立即保存 Theme 与 reasoning visibility |

### Workspace 与 Files

| Method | Path | 用途 |
|---|---|---|
| GET/POST | `/api/workspaces` | 列出或添加 Workspace |
| PATCH/DELETE | `/api/workspaces/:workspaceId` | 重命名或关闭 Workspace |
| GET | `/api/directories` | 目录建议 |
| GET | `/api/workspaces/:workspaceId/files` | 目录列表 |
| GET | `/api/workspaces/:workspaceId/file` | 文本或图片 preview metadata；执行 Global preview limit |
| GET | `/api/workspaces/:workspaceId/image` | Files/Markdown image stream；执行 Global preview limit |
| GET | `/api/workspaces/:workspaceId/download` | 原始文件 stream download；不执行 preview limit |
| GET/PUT | `/api/workspaces/:workspaceId/notebook` | 读取或自动保存 Workspace Notebook |

### Settings

| Method | Path | 用途 |
|---|---|---|
| GET/PUT | `/api/settings/global` | Global defaults 与兼容的 credential 保存入口 |
| PUT | `/api/settings/agent-defaults` | 立即保存 message queue、compaction 和 retry defaults |
| GET | `/api/settings/models` | Provider catalog model list |
| GET/PUT | `/api/settings/model-preferences` | 已认证 Provider 的模型清单、checkbox、default 和 thinking level |
| POST | `/api/settings/providers/:providerId/api-key` | 保存指定 Provider 的 API key |
| DELETE | `/api/settings/providers/:providerId/credential` | 删除指定 Provider 的保存 credential |
| GET | `/api/settings/session-models` | 当前已勾选且可用的 Session models |
| GET/PUT | `/api/settings/system-prompt` | 读取 effective prompt preview，或保存 Global append |
| GET/PUT | `/api/settings/preferences` | 共享 Agent tools 与 Files preferences |
| GET | `/api/settings/release` | Pi-Ark、bundled pi core、安装状态、路径、命令和 latest release |
| POST | `/api/settings/release/update` | 安装并切换到 latest Pi-Ark release |
| POST | `/api/settings/release/rollback` | 切换到 previous Pi-Ark release |
| POST/GET/DELETE | `/api/settings/subscription-logins...` | OAuth flow start、poll 和 cancel |
| POST | `/api/settings/subscription-logins/:flowId/answer` | OAuth prompt answer |

### Session

| Method | Path | 用途 |
|---|---|---|
| GET/POST | `/api/workspaces/:workspaceId/sessions` | List 或 create Session |
| GET | `/api/workspaces/:workspaceId/session-statuses` | 已打开的 Session runtime 状态与 status/update revisions |
| PATCH/DELETE | `/api/workspaces/:workspaceId/sessions/:sessionId` | Metadata/name update 或 delete |
| POST | `/api/workspaces/:workspaceId/sessions/:sessionId/fork` | Fork |
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

Browser commands：

- `prompt`
- `load-earlier`
- `abort`
- `rename-session`
- `set-model`
- `set-thinking-level`

Server messages：

- `snapshot`，其中 messages 包含 `messageId`，Session state 包含 `messageNumberOffset`、`totalDisplayMessages`、`targetMessageId`、`hasEarlierMessages` 和 `queueRevision`
- `queue-state`，其中包含 Queue items、`queueRevision` 和可选的 `confirmedOperationId`
- `agent-event`
- `notice`
- `error`
- `session-deleted`

### Terminal

Path：`/ws/terminal/:workspaceId`

Browser messages：`input` 和 `resize`。Server messages：`output`、`exit` 和 `error`。

## Release 构建与安装

`npm run release:build` 生成 `pi-ark-<version>-linux-<architecture>.tar.gz`。Artifact 包含编译后的 Server/Web、production dependencies、native node-pty、CLI、installer 和 `RELEASE.json`。GitHub Actions 分别在 Linux x64 与 arm64 runner 上构建 architecture-specific artifact，并将 tag 对应的 artifact 发布到 GitHub Releases。

System installer 使用以下布局：

```text
/opt/pi-ark/
  current -> releases/<version>
  previous -> releases/<previous-version>
  releases/<version>/
/var/lib/pi-ark/
  config.json
  tls/
  pi-agent/
/etc/systemd/system/pi-ark.service
/usr/local/bin/pi-ark
```

Installer 默认创建专用的 `pi-ark` service account。`--migrate-data` 可以复制现有 Global data 并更新其中指向旧 data directory 的 TLS paths。systemd 在每次启动前执行 release preflight，并从 `current` 运行 CLI 的 `serve` 命令。

Multi-instance installation 通过 `PI_ARK_INSTANCE`、`PI_ARK_BASE_PATH`、`PI_ARK_SERVICE_NAME` 和 `PI_ARK_CLI_NAME` 描述当前实例。Installer 为非 default instance 生成独立的 service unit 与 instance-aware CLI launcher，并通过 `--port` 修改迁移后的 listen port。`--deferred-restart` 创建 transient systemd timer，避免部署进程随当前 service restart 一起终止。

Frontend 从 `document.baseURI` 推导 base path。所有 API、WebSocket、Files image 和 download URL 都经过同一个 base-path helper；Vite build 使用 relative asset URL。Nginx 在 public URL 上保留 base path，并通过带末尾 `/` 的 `proxy_pass` 将该前缀移除后发送给 Fastify。Fastify 的内部 routes 继续使用 `/api` 与 `/ws`。

Auth cookie name 包含 `PI_ARK_INSTANCE`，cookie Path 对应 `PI_ARK_BASE_PATH`。同一个 hostname 下的实例不会互相覆盖 auth cookie。各实例使用独立的 Global data 与 pi agent data；Workspace `.pi-ark` state 可以共享。同一个 Session 由一个实例执行写操作。

## Static assets 与 URL fallback

Server 从 `apps/web/dist` 读取 Web assets。带 hash 的文件使用一年 immutable cache，其他文件使用 `no-cache`。不存在扩展名的路径返回 `index.html`，支持浏览器页面刷新；不存在的带扩展名路径返回 404。

## 安全说明

- TLS key、credential、password hash 和 Workspace state 应由服务账号管理。
- Auth session 保存在内存中，服务重启后浏览器需要重新登录。
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
npm run check:ui
npm run release:build
```

Behavior scripts 覆盖 conversation segmentation、Session snapshot/UI state LRU、Server display pagination、active Session Fork、attachments、OAuth flow、模型偏好与 credential 断开、Session actions、system prompt、Workspace Files schema、preview 和 download metadata。Chromium script 覆盖主要页面交互、dialog、rollback、permalink、首次 loading snapshot、缓存 Session 的即时显示与后台更新、Session 切换后的 draft/attachment/disclosure 恢复、dark theme fold contrast、earlier message 加载、tool details、interrupted warning、Files 图片/超限下载、模型 checkbox/default 和 Settings 自动保存。
