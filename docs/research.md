# Pi 集成调研

## 结论

Pi-Ark 使用 `@earendil-works/pi-coding-agent` TypeScript SDK 进行进程内集成。该方式提供结构化 message、流式 event、tool lifecycle、SessionManager、SettingsManager 和 ModelRuntime，适合由 Fastify 维护共享 runtime 并向浏览器发送 WebSocket snapshot。

Pi-Ark 不解析 pi CLI 文本，也不为每条 message 启动独立 pi process。Terminal 是独立的 node-pty 功能，与 AgentSession runtime 分开。

## AgentSession 与 SessionManager

Pi-Ark 使用以下公开 API：

- `createAgentSession(...)`：按 Workspace cwd、SessionManager、tools 和 ResourceLoader 创建 runtime，并通过 `customTools` 注册 Pi-Ark 自带的 `read_pi_ark_link`。
- `SessionManager.create(cwd, sessionDir)`：在 Workspace state directory 中创建持久化 Session。
- `SessionManager.list(cwd, sessionDir)`：列出 Workspace Session。
- `SessionManager.open(path, sessionDir)`：恢复 JSONL Session。
- `SessionManager.inMemory()`：为 Global effective system prompt preview 创建临时 Session。
- `SessionManager.findById(cwd, id, sessionDir)`：按 Session ID 查找真实文件，通过 header discovery 避免读取其他 Session 的完整正文。
- `parseSessionEntries(content)` 与 `SessionManager.inMemory(cwd, undefined, entries)`：在内存中加载 link 目标文件，并在内存中完成旧格式的迁移。
- `getBranch()`：读取当前活动 branch 的完整 entry path，用于浏览器 display projection。
- `sessionEntryToContextMessages(entry)`：将 message、compaction、branch summary 和可显示 custom message entry 转换为 Web message，同时保留 source entry。
- `buildSessionContext()`：判断已有 Session 并让 Agent runtime 恢复 pi 的 compaction-aware 模型上下文。
- `createBranchedSession(entryId)`：从指定 entry 创建 Fork。
- `navigateTree(entryId, ...)`：移动活动 branch，用于 Rollback 和 Restore。
- `appendCustomEntry(...)`：保存 Pi-Ark rollback marker，同时避免将内部状态作为普通 user/assistant message。
- `session.subscribe(listener)`：接收 message、tool、queue 和 agent lifecycle events。
- `session.prompt(...)`：在 idle Session 中启动 user turn。
- `session.steer(...)` 与 `session.followUp(...)`：在运行期间维护两种 queue 语义。
- `session.clearQueue()`：在 Pi-Ark 重新排序 queue 时清空已有内容。
- `session.abort()`：中止当前执行并等待 runtime 回到 idle。
- `session.dispose()`：释放 listener 和 extension resources。

## Settings 与 model runtime

Pi-Ark 使用以下能力：

- `SettingsManager.create(cwd, agentDir, { projectTrusted: false })`：从 Global 读取和写入 enabled models、default provider/model/thinking、queue modes、compaction 和 retry。SettingsService、ResourceLoader 与 AgentSession 共用该创建方式。
- `SettingsManager.getEnabledModels()/setEnabledModels()`：读取和保存模型可见清单。
- `ModelRuntime.create(...)`：读取 provider catalog、credentials 和 custom model config。
- `ModelRuntime.login(provider, "api_key", interaction)`：保存 API key。
- `ModelRuntime.login(provider, "oauth", interaction, { getDeviceId })`：执行 pi 原生 OAuth 或 device code flow，并向需要安装实例标识的 Provider 提供 `SettingsManager.getOrCreateDeviceId()`。
- `ModelRuntime.logout(provider)`：删除指定 Provider 的保存 credential。
- `resolveModelScopeWithDiagnostics(patterns, modelRuntime)`：将 `enabledModels` pattern 解析为当前可用的 scoped models。
- `getSupportedThinkingLevels(model)`：获得 model-specific thinking options。
- `clampThinkingLevel(model, level)`：在读取 Global settings 时处理 model capability 变化。

Provider credential 保存在 Pi-Ark 专用 agent directory 的 `auth.json` 中。浏览器只接收 provider auth status、source 和 label。

## ResourceLoader 与 system prompt

Pi-Ark 使用 `DefaultResourceLoader` 组合以下内容：

- pi 内置 system prompt sections。
- `PI_ARK_AGENT_DIR/SYSTEM.md`。
- `PI_ARK_AGENT_DIR/APPEND_SYSTEM.md`。
- Workspace context files。
- Skills 和其他 pi resources。
- Global preferences 中的 system prompt append。

Global preview 与实际 runtime 共用 ResourceLoader 创建流程，通过临时 AgentSession 的 `systemPrompt` 读取 complete effective prompt。Loader 显式选择 Global `SYSTEM.md` 与 `APPEND_SYSTEM.md`，并使用 `appendSystemPromptOverride` 在 Global append resources 后面追加共享内容。Workspace 的 AGENTS.md 保持为项目上下文。

## Compact 的统计信息

Pi-Ark 使用 SDK 的 `buildSessionProjection(entries, compactionEntryId, byId)` 重建每次压缩当时的上下文，并通过 `getCurrentSystemMessage()` 与 `estimateTokens()` 计算压缩后的组成。`tokensBefore` 来自原生 compaction entry；After、System prompt、Summary 和 Retained 使用 SDK 的估算方法。`CompactionEntry.usage` 提供生成摘要的 input/output token 用量。

AgentService 从 `compaction_start` 与 `compaction_end` 测量耗时，并通过 `appendCustomEntry()` 追加 `pi-ark.compaction-timing`，将耗时和触发原因关联到原生 compaction entry。该 custom entry 是展示数据。读取历史统计时保持 Session 的活动 leaf，并以压缩当时的记录为依据。

## Pi-Ark 自带的链接读取工具

Pi-Ark 使用 SDK 的 `defineTool()` 定义 `read_pi_ark_link`，并通过 `createAgentSession({ customTools, tools })` 注册和启用。工具的参数与 `outputSchema` 使用 TypeBox，成功结果同时返回模型可读的 JSON text 和 `structuredContent`。`description`、`promptSnippet` 和 `promptGuidelines` 提供工具选择说明；读取与标识映射由 Server 的 `SessionReader` 执行。

Web 和工具共用内部链接解析、完整活动分支的 display projection，以及短 Message ID 与旧数字目标的定位。对于已有 runtime，reader 使用其 SessionManager；对于其他 Session，reader 使用公开的文件解析和内存加载 API。该选择保留原文件，并保持目标 Agent 的 lifecycle 和活动 leaf。与恢复 runtime 所用的 `SessionManager.open()` 相比，内存加载将旧格式的迁移保留在内存中。

工具提供 Workspace 摘要、Session 分页、Message 前后文和长正文续读。单次 JSON text 最多为 48 KiB，`nextContentOffset` 与分页位置支持后续读取。该能力通过进程内的 native custom tool 提供，SessionReader 作为独立模块供后续集成复用。

## Session 存储选择

Pi-Ark 显式传入 `<workspace>/.pi-ark/sessions`，使 Session 与 Workspace data 一起管理。Session 文件继续采用 pi 原生 JSONL tree，保留以下信息：

- Message entries。
- Parent/branch 关系。
- Model 和 thinking level changes。
- Compaction entries。
- Usage 和 cost。
- Pi-Ark rollback custom entries。

Pin、Archive 和 Session group 属于 Pi-Ark UI metadata，因此保存在独立的 `sessions-meta.json`，避免改写 pi message tree。

## Event 与 snapshot 选择

WebSocket 连接后先发送权威 snapshot。Server 从当前活动 branch 的完整 entry path 构建并缓存 display projection，因此该 projection 包含 compact 前的原始 messages 和每个 compaction summary；普通初始 snapshot 只传输最新约 100 条 messages 所在的 display window，并携带全局 offset、完整数量和 earlier 状态。浏览器通过 `load-earlier` 扩展当前 client 的 window。运行期间，Server 转发 pi SDK event，使浏览器及时显示 user message、streaming content 和 tool status；在关键 lifecycle event 后，Server 清除已变化的 display projection cache，并为每个 client 发送其当前 window 的权威 snapshot。Agent runtime 仍由 SessionManager 的 compaction-aware projection 构建模型上下文。

pi 的 public `message_end` listener 在 SessionManager 持久化 completed message 之前执行。Pi-Ark 在 listener 返回后的下一次 task 中生成 snapshot，使 event 已经显示的 message 继续存在于权威 projection 中。完整 Agent run 从 agent start 开始，并在 agent settled 时结束；单条 message end 表示其中一条 message 已完成。

这种组合有以下作用：

- Event 提供低延迟更新。
- Snapshot 纠正浏览器临时状态，并以 SessionManager 的完整活动 branch display projection 为权威显示数据。
- Agent settled 状态用于决定 completed、interrupted 和 working UI。
- 浏览器断线不会停止 Agent runtime。
- 多个浏览器连接可以共享同一个 runtime。

首次打开且没有浏览器内存 cache 时，Web 以首个 snapshot 判定 Session 加载完成。切回最近五个 Session 时，Web 先显示内存 LRU snapshot，再在后台以 Server snapshot 更新。独立的五 Session UI LRU 保存 composer draft、attachments 和 disclosure states；这些状态保持在浏览器内存中，并使用 source entry/tool call identity 恢复。Socket open 只说明 transport 已经建立。

## Queue 处理

Pi SDK 提供 Steering 和 Follow-up queue。Pi-Ark 额外维护 UI item ID、mode、text 和 image，以支持重排和 mode 切换。

由于 SDK 的公开 API 提供 clear、steer 和 followUp，Pi-Ark 在更新 mode、顺序、Edit 或 Merge 时仍需要清空 Queue，然后按新顺序重新提交。Pi-Ark 使用 queue rebuild version 和共享 promise 合并快速连续操作；rebuild 期间目标 Queue 发生变化时，再使用最新目标执行一轮。Queue update event 只同步 metadata 并发送轻量 `queue-state`，不清除 conversation display projection cache。Web 使用 operation ID、queue revision 和 optimistic operations 提供即时反馈，同时保留 pi Queue 的权威状态。

## Fork 与 Rollback

Fork 使用单独打开的 SessionManager，避免 Fork 操作改变当前 Session 的活动 branch。

Rollback 使用 SessionManager tree navigation，目标是最后一条完整 user turn 之前的 parent entry。原 leaf 和 user text 存入 custom marker；Restore 根据 marker 回到原 leaf。该方案不修改 Workspace 文件，也不删除原 branch。

## 版本与 release 更新

Pi-Ark `0.1.4` 正式版本将 `@earendil-works/pi-coding-agent` 和 `@earendil-works/pi-ai` 固定为 `1.5.0`，并增加 base path、instance-specific auth cookie、multi-instance installer 和 deferred restart。相关 SDK dependencies 作为同一个 Pi-Ark release 的 production dependencies 构建和检查，运行中的安装不会单独修改 pi SDK package。

GitHub Releases 为 Linux x64 和 arm64 分别提供包含 native node-pty 的 artifact。Pi-Ark update 下载完整 artifact，检查 release metadata 与 runtime imports，然后通过 `current` symlink 切换版本。Previous release 继续保留，供 rollback 使用。该方式使 Pi-Ark 代码、Web assets 和 pi SDK 使用同一套已检查的版本组合。

## 参考资料

- pi `README.md`
- pi `docs/sdk.md`
- pi `docs/sessions.md`
- pi `docs/session-format.md`
- pi `docs/message-types.md`
- pi `docs/configuration.md`
- pi `docs/models.md`
- pi `docs/providers.md`
- pi `examples/sdk/01-minimal.ts`
- pi `examples/sdk/09-api-keys-and-oauth.ts`
- pi `examples/sdk/11-sessions.ts`
- pi `examples/sdk/13-session-runtime.ts`
