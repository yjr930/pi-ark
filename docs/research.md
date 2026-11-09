# Pi 集成调研

## 结论

Pi-Ark 使用 `@earendil-works/pi-coding-agent` TypeScript SDK 进行进程内集成。该方式提供结构化 message、流式 event、tool lifecycle、SessionManager、SettingsManager 和 ModelRuntime，适合由 Fastify 维护共享 runtime 并向浏览器发送 WebSocket snapshot。

Pi-Ark 不解析 pi CLI 文本，也不为每条 message 启动独立 pi process。Terminal 是独立的 node-pty 功能，与 AgentSession runtime 分开。

## AgentSession 与 SessionManager

Pi-Ark 使用以下公开 API：

- `createAgentSession(...)`：按 Workspace cwd、SessionManager、tools 和 ResourceLoader 创建 runtime。
- `SessionManager.create(cwd, sessionDir)`：在 Workspace state directory 中创建持久化 Session。
- `SessionManager.list(cwd, sessionDir)`：列出 Workspace Session。
- `SessionManager.open(path, sessionDir)`：恢复 JSONL Session。
- `SessionManager.inMemory()`：为 Global effective system prompt preview 创建临时 Session。
- `buildSessionProjection()`：从当前 branch 生成浏览器 snapshot messages，并保留 source entry。
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

- `SettingsManager.create(cwd, agentDir)`：读取和写入 default provider/model/thinking、queue modes、compaction 和 retry。
- `ModelRuntime.create(...)`：读取 provider catalog、credentials 和 custom model config。
- `ModelRuntime.login(provider, "api_key", interaction)`：保存 API key。
- `ModelRuntime.login(provider, "oauth", interaction)`：执行 pi 原生 OAuth 或 device code flow。
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
- Workspace system prompt append。

Global preview 通过临时 AgentSession 的 `systemPrompt` 读取 complete effective prompt。Workspace append 使用 `appendSystemPromptOverride` 放在 Global append resources 后面。

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

WebSocket 连接后先发送完整 snapshot。运行期间，Server 转发 pi SDK event，使浏览器及时显示 streaming content 和 tool status；在关键 lifecycle event 后，Server重新发送完整 snapshot。

这种组合有以下作用：

- Event 提供低延迟更新。
- Snapshot 纠正浏览器临时状态，并以 SessionManager projection 为权威数据。
- 浏览器断线不会停止 Agent runtime。
- 多个浏览器连接可以共享同一个 runtime。

Web 以首个 snapshot 判定 Session 加载完成。Socket open 只说明 transport 已经建立。

## Queue 处理

Pi SDK 提供 Steering 和 Follow-up queue。Pi-Ark 额外维护 UI item ID、mode、text 和 image，以支持重排和 mode 切换。

由于 SDK 的公开 API 提供 clear、steer 和 followUp，Pi-Ark 在更新顺序时清空 queue，然后按新顺序重新提交。Queue update event 再与 Pi-Ark metadata 同步。

## Fork 与 Rollback

Fork 使用单独打开的 SessionManager，避免 Fork 操作改变当前 Session 的活动 branch。

Rollback 使用 SessionManager tree navigation，目标是最后一条完整 user turn 之前的 parent entry。原 leaf 和 user text 存入 custom marker；Restore 根据 marker 回到原 leaf。该方案不修改 Workspace 文件，也不删除原 branch。

## 版本更新

Pi core update 同时更新相同版本的 `@earendil-works/pi-coding-agent` 和 `@earendil-works/pi-ai`。更新后执行 Server TypeScript check 和 build，再通过 systemd timer 安排服务重启。

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
