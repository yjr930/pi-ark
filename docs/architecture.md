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
| Global/Workspace config | `apps/server/src/config.ts` | 配置解析、data directory、Workspace schema 和原子写入 |
| Authentication | `apps/server/src/auth.ts` | scrypt password、内存 session token 和 cookie |
| Workspace and Files | `apps/server/src/workspaces.ts` | Workspace registry、目录建议、安全路径、文本与图片预览和文件下载 |
| Agent runtime | `apps/server/src/agents.ts` | pi Session 生命周期、snapshot、queue、fork、rollback、attachments 和广播 |
| Attachments | `apps/server/src/attachments.ts` | 限额检查、文件名清理、保存和 image content 转换 |
| Session metadata | `apps/server/src/session-metadata.ts` | Pin、Archive、group 和串行原子写入 |
| Global settings | `apps/server/src/settings.ts` | Provider、model、thinking、queue、compaction、retry 和 credential login |
| OAuth flow | `apps/server/src/auth-flows.ts` | Subscription login 的事件、prompt、answer 和 cancel 状态 |
| Pi-Ark release | `apps/server/src/pi-core.ts` | Pi-Ark 与 bundled pi core 版本信息、GitHub Releases 查询、完整 release 更新、回退和延迟重启 |
| Terminal | `apps/server/src/terminal.ts` | node-pty、input/output、resize 和 process exit |

## Web 模块

| 模块 | 文件 | 职责 |
|---|---|---|
| Application shell | `apps/web/src/App.tsx` | Auth 状态、Workspace/Session 选择、页面导航、URL 和响应式侧栏 |
| Agent page | `apps/web/src/components/Chat.tsx` | WebSocket snapshot、message renderer、composer、queue、fork 和 rollback |
| Conversation segmentation | `apps/web/src/conversation.ts` | Turn 分段、tool run collapse 和 interrupted warning |
| Workspace list | `apps/web/src/components/WorkspaceList.tsx` | 选择、重命名和关闭 Workspace |
| Session list | `apps/web/src/components/SessionList.tsx` | Session actions、groups 和 Archived 区域 |
| Files | `apps/web/src/components/Files.tsx` | 全宽目录导航、可调整的文件列表、path copy、文本阅读和 Markdown image path |
| Markdown | `apps/web/src/components/Markdown.tsx` | marked、DOMPurify、链接和图片展示 |
| Terminal | `apps/web/src/components/Terminal.tsx` | xterm.js、FitAddon 和 Terminal WebSocket |
| Settings | `apps/web/src/components/Settings.tsx` | 分类展示 Global/Workspace settings、prompt preview、OAuth、release update/rollback 和 service commands |
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
- 已连接的 WebSocket clients
- pi event unsubscribe function
- Pi-Ark queue metadata
- queue rebuild 状态

多个浏览器连接共享同一个 Session runtime。浏览器断开不会中止 Agent；重新连接会收到当前 snapshot。

### Session 创建与恢复

新 Session 使用 `SessionManager.create(workspace.path, sessionDir)`。恢复使用 `SessionManager.open(jsonlPath, sessionDir)`。Workspace session directory 固定为 `<workspace>/.pi-ark/sessions/`。

创建 AgentSession 时，AgentService 加载以下输入：

- Workspace cwd。
- Workspace 启用的 tools。
- Pi-Ark agent directory 中的 Global resources。
- Workspace system prompt append。
- 已有 SessionManager。

### Snapshot

连接成功后，Server 立即发送 snapshot。Snapshot message 来源是 `buildSessionProjection()`；每条 message 附加 source entry ID，assistant message 还附加 model context window。

Snapshot 包含以下状态：

- Session ID 和名称。
- Projection messages。
- Streaming 和 idle 状态。
- 当前 model 和 thinking level。
- 可用 thinking levels。
- Queue。
- Rollback 和 restore 状态。
- Session statistics。

Web 将首个 snapshot 作为加载完成依据。Socket open 只表示连接成功。

### Streaming events

AgentSession subscription 将 pi events 通过 `agent-event` 转发给所有 clients。Web 使用 message start/update/end 更新流式内容。Server 在 message end、agent settled 和 queue update 后再次发送完整 snapshot，使 SessionManager projection 成为权威状态。

### Prompt 与 attachments

WebSocket prompt 可以包含文字和 base64 attachments。Attachment service 执行文件数量、单文件大小和总大小检查，然后保存到 Session attachment directory。

Prompt 文字追加保存后的文件名和绝对路径。支持的图片同时作为 pi image content 发送；普通附件通过路径供 Agent tools 使用。

Session idle 时调用 `session.prompt()`。Session streaming 时，Pi-Ark 将新 message 记录为 Follow-up queue item，并调用 `session.followUp()`。

### Queue

Runtime 启动时，Pi-Ark 从 pi 的 steering/follow-up queues 建立带随机 ID 的 UI metadata。Queue update event 会按 mode 和 text 复用已有 ID。

重新排序或切换 mode 时，AgentService 执行以下步骤：

1. 复制当前 queue。
2. `clearQueue()`。
3. 按新顺序重新提交 Steering items。
4. 按新顺序重新提交 Follow-up items。
5. 重新同步 metadata 并发送 snapshot。

该流程保留 Pi-Ark queue item 中的 image content。

### Fork

Fork 使用单独打开的 SessionManager，并调用 `createBranchedSession(entryId)`。该操作不会移动当前 Session 的活动 leaf。新 Session 建立后，浏览器设置名称并切换到新分支。

### Rollback 与 Restore

可回退状态要求 Session idle、queue 为空，并且活动 leaf 不是已有 rollback marker。AgentService 在当前 branch 中查找最后一条 user entry，以及该 entry 后最后一个完成的 assistant output。

Rollback 将 SessionManager 移动到 user entry 的 parent，并追加 `pi-ark.rollback` custom entry。Marker 保存以下数据：

- rollback target ID。
- 原分支 leaf ID。
- 原 user message text。

Snapshot 根据活动 leaf 暴露 rollback state。Web 将 user text 放回 composer。Restore 移动回保存的 leaf，并追加 `pi-ark.rollback-restored` marker。发送替代 message 后，rollback marker 不再是活动 leaf，restore 入口随之失效。

### Delete 与 shutdown

Delete 会清空 queue、中止运行中的 Agent、释放 subscription 和 runtime、关闭 clients，并删除 JSONL、Session attachment directory 和 metadata。

Server shutdown 会依次清空所有 queue、中止 active Agent、释放 runtime 并关闭 WebSocket clients。

## Conversation projection

`buildConversationSegments()` 以 user message 划分 turn。

- 没有 tool activity 的 turn 按 message 顺序展示。
- Streaming 中的当前 turn 保持展开。
- 已完成 tool turn 将最终 assistant response 之前的过程放入 run collapse。
- Idle 且缺少 final assistant response 的 tool turn 将全部过程放入 run collapse，并追加 warning segment。

Run collapse 内的 tool call 与 tool result 由 Chat renderer 生成嵌套 details。Message permalink 指向内部 message 时，外层 run 自动打开；内层 details 默认保持关闭。

Warning segment 是前端显示状态，不写入 pi JSONL，也不参与 message numbering、Fork 或 Rollback。

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

- Theme 和 Workspace registry：`PI_ARK_HOME/config.json`。
- Default provider/model/thinking、queue modes、compaction 和 retry：`PI_ARK_AGENT_DIR/settings.json`。
- Credentials：`PI_ARK_AGENT_DIR/auth.json`。
- Custom models：`PI_ARK_AGENT_DIR/models.json`。

API key 通过 `ModelRuntime.login(provider, "api_key", interaction)` 写入。Settings response 只返回 credential 状态和来源，不返回 credential 内容。

### Subscription OAuth

Provider 的 `auth.oauth.isSubscription` 决定 UI 是否显示 subscription login。AuthFlowService 将 pi OAuth interaction 转换为可轮询状态，支持 info、auth URL、device code、progress、text/secret/manual code prompt、select prompt 和 cancel。

Flow、events 和待回答 prompt 保存在服务内存中。Flow event 最多保留最近 50 条。

### System prompt

Global system prompt 的可选文件是：

```text
PI_ARK_AGENT_DIR/SYSTEM.md
PI_ARK_AGENT_DIR/APPEND_SYSTEM.md
```

Global preview 使用 DefaultResourceLoader 和临时 AgentSession 生成 complete effective prompt。Workspace append 通过 `appendSystemPromptOverride` 加到 Global append resources 后面。

Workspace config schema version 是 5，system prompt 与 Files 字段为：

```json
{
  "agent": {
    "systemPrompt": {
      "append": "Workspace-specific instructions"
    }
  },
  "files": {
    "showHiddenFiles": true,
    "maxPreviewSizeMb": 10
  }
}
```

读取 version 4 配置时，缺少的 `maxPreviewSizeMb` 使用 10 MB；下次保存会写入 version 5。普通 Workspace settings PUT 只更新 tools 与 files，并保留服务端当前 prompt；prompt 使用独立 endpoint 保存，避免自动保存覆盖尚未确认或刚确认的 prompt。

### Pi-Ark release 管理

Release manager 从 release 目录的 `RELEASE.json` 读取 Pi-Ark 与 bundled pi core 版本，并通过 GitHub Releases API 查询 stable channel。开发 checkout 没有 `RELEASE.json`，因此只提供版本和路径信息。

`pi-ark update` 执行以下流程：

1. 查询 GitHub 的 latest release，并选择当前 Linux architecture 对应的 artifact。
2. 下载并解压到临时目录。
3. 检查 `RELEASE.json`、必要的 Server/Web 文件、pi SDK import 和 node-pty native module。
4. 将 release 复制到 `/opt/pi-ark/releases/<version>`。
5. 保存当前 release 为 `previous`，再通过临时 symlink rename 原子切换 `current`。
6. Web update API 在返回响应后退出服务进程；systemd 根据 `Restart=always` 从新的 `current` 启动。
7. CLI service supervisor 请求新进程的 `/api/health`；30 秒内无法通过时，它恢复 previous release，并让 systemd 再次启动。

`pi-ark rollback` 对调 `current` 与 `previous`，并使用相同的延迟重启流程。Global data 和 Workspace data 位于 release 目录之外，因此更新与回退不会改写这些数据。

日常迭代使用 `<next-version>-dev.<iteration>` SemVer prerelease。开发 artifact 可以安装到本机 `/opt/pi-ark/releases/<dev-version>` 并通过同一套 preflight、symlink 和 systemd 流程运行，但不会创建 Git tag 或 GitHub Release。正式 release 需要明确的发布安排。

## 数据存储

### Global data

| 路径 | 内容 |
|---|---|
| `PI_ARK_HOME/config.json` | Listen、TLS、auth hash、Workspace registry 和 theme |
| `PI_ARK_HOME/tls/` | Setup 生成的 TLS key 和 certificate |
| `PI_ARK_AGENT_DIR/auth.json` | pi provider credentials |
| `PI_ARK_AGENT_DIR/settings.json` | pi Global defaults |
| `PI_ARK_AGENT_DIR/models.json` | Custom provider/model config |
| `PI_ARK_AGENT_DIR/SYSTEM.md` | 可选 Global replacement prompt |
| `PI_ARK_AGENT_DIR/APPEND_SYSTEM.md` | 可选 Global append prompt |

### Workspace data

| 路径 | 内容 |
|---|---|
| `<workspace>/.pi-ark/config.json` | Tools、Workspace prompt append 和 Files preference |
| `<workspace>/.pi-ark/sessions/*.jsonl` | pi session tree |
| `<workspace>/.pi-ark/sessions-meta.json` | Pin、Archive、groups 和 group definitions |
| `<workspace>/.pi-ark/attachments/<session>/` | Session attachments |

Global config、Workspace config 和 Session metadata 使用 temporary file 加 rename 的方式写入。Global config 使用服务进程级 write queue；Workspace config 和 Session metadata 按 Workspace 使用 write queue，避免自动保存与并发请求相互覆盖。

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
| GET/PUT | `/api/ui` | 读取或立即保存 Theme |

### Workspace 与 Files

| Method | Path | 用途 |
|---|---|---|
| GET/POST | `/api/workspaces` | 列出或添加 Workspace |
| PATCH/DELETE | `/api/workspaces/:workspaceId` | 重命名或关闭 Workspace |
| GET | `/api/directories` | 目录建议 |
| GET/PUT | `/api/workspaces/:workspaceId/settings` | Workspace settings |
| PUT | `/api/workspaces/:workspaceId/system-prompt` | Workspace prompt append |
| GET | `/api/workspaces/:workspaceId/files` | 目录列表 |
| GET | `/api/workspaces/:workspaceId/file` | 文本或图片 preview metadata；执行 Workspace preview limit |
| GET | `/api/workspaces/:workspaceId/image` | Files/Markdown image stream；执行 Workspace preview limit |
| GET | `/api/workspaces/:workspaceId/download` | 原始文件 stream download；不执行 preview limit |

### Settings

| Method | Path | 用途 |
|---|---|---|
| GET/PUT | `/api/settings/global` | Provider、model、thinking 与 credential 确认 |
| PUT | `/api/settings/agent-defaults` | 立即保存 message queue、compaction 和 retry defaults |
| GET | `/api/settings/models` | Provider model list |
| GET | `/api/settings/session-models` | 当前可用 Session models |
| GET | `/api/settings/system-prompt` | Effective prompt preview |
| GET | `/api/settings/release` | Pi-Ark、bundled pi core、安装状态、路径、命令和 latest release |
| POST | `/api/settings/release/update` | 安装并切换到 latest Pi-Ark release |
| POST | `/api/settings/release/rollback` | 切换到 previous Pi-Ark release |
| POST/GET/DELETE | `/api/settings/subscription-logins...` | OAuth flow start、poll 和 cancel |
| POST | `/api/settings/subscription-logins/:flowId/answer` | OAuth prompt answer |

### Session

| Method | Path | 用途 |
|---|---|---|
| GET/POST | `/api/workspaces/:workspaceId/sessions` | List 或 create Session |
| PATCH/DELETE | `/api/workspaces/:workspaceId/sessions/:sessionId` | Metadata/name update 或 delete |
| POST | `/api/workspaces/:workspaceId/sessions/:sessionId/fork` | Fork |
| POST | `/api/workspaces/:workspaceId/sessions/:sessionId/rollback` | Rollback |
| POST | `/api/workspaces/:workspaceId/sessions/:sessionId/rollback/restore` | Restore rollback |
| PATCH | `/api/workspaces/:workspaceId/sessions/:sessionId/queue/:itemId` | Queue reorder/mode |
| GET/POST | `/api/workspaces/:workspaceId/session-groups` | List 或 create group |
| PATCH/DELETE | `/api/workspaces/:workspaceId/session-groups/:groupId` | Rename 或 delete group |

## WebSocket

### Agent

Path：`/ws/agent/:workspaceId/:sessionId`

Browser commands：

- `prompt`
- `abort`
- `rename-session`
- `set-model`
- `set-thinking-level`

Server messages：

- `snapshot`
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

Installer 默认创建专用的 `pi-ark` service account。`--migrate-data` 可以复制现有 Global data 并更新其中指向旧 data directory 的 TLS paths。systemd 在每次启动前执行 release preflight，并从 `current` 运行 CLI 的 `serve` 命令。日常开发安装沿用本机服务当前的 data directory、service user、service group 和 listen 配置。

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

Behavior scripts 覆盖 conversation segmentation、attachments、OAuth flow、Session actions、system prompt、Workspace Files schema、preview 和 download metadata。Chromium script 覆盖主要页面交互、dialog、rollback、permalink、loading snapshot、tool details、interrupted warning、Files 图片/超限下载和 Settings 自动保存。
