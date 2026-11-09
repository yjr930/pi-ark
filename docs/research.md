# Pi 集成调研

## 结论

Pi-Ark 使用 `@earendil-works/pi-coding-agent` TypeScript SDK 进行进程内集成。该方案提供结构化消息、流式事件、工具执行事件和 session manager，比解析 CLI 文本更适合 Web UI。

## 采用的公开 API

- `createAgentSession({ cwd, sessionManager })`: 为指定工作区创建 agent session。
- `SessionManager.create(cwd, sessionDir)`: 在工作区的 `.pi-ark/sessions` 中建立持久化会话。
- `SessionManager.list(cwd, sessionDir)`: 列出指定工作区的会话。
- `SessionManager.open(path)`: 恢复已存在的 JSONL 会话。
- `session.subscribe(listener)`: 接收消息增量、工具执行和 agent lifecycle 事件。
- `session.prompt(text)`: 发送普通 prompt，并等待 agent 完成本轮执行。
- `session.steer(text)` 与 `session.followUp(text)`: 在流式执行期间发送明确语义的后续消息。
- `session.abort()`: 中止当前执行并等待 session 回到 idle 状态。
- `session.dispose()`: 释放事件监听器和扩展资源。

## 存储选择

pi 默认按工作目录把会话保存在全局 agent 目录。Pi-Ark 显式传入 custom session directory，使数据位置符合 `<workspace>/.pi-ark/sessions` 的产品要求。session 文件继续采用 pi 原生 JSONL 格式，因此 pi 自带的树结构、压缩记录、模型变化和使用量信息均可保留。

模型凭证继续由 pi 的全局 agent 目录管理。默认目录是 `~/.pi/agent`，也可以通过 `PI_CODING_AGENT_DIR` 配置。Pi-Ark 不复制或展示凭证。

## 事件映射

WebSocket 在连接后先发送完整消息快照。运行期间，服务端转发 pi SDK 事件；收到 `message_update` 时，前端更新当前 assistant 消息；收到 `message_end` 或 settled 事件时，服务端再次发送权威消息快照。

前端应容纳未知的消息 role 和 content block。当前界面重点渲染 `user`、`assistant` 和 `toolResult`，其余类型保留通用的 JSON 或文字摘要。

## 并发策略

每个已打开的 session 在服务端对应一个运行时实例。多个浏览器连接共享该实例和事件广播。session 正在执行时，普通 prompt 明确映射为 `followUp`，中止请求映射为 `abort`。不同 session 可以并行运行。

## 参考资料

- pi `docs/sdk.md`
- pi `docs/sessions.md`
- pi `docs/session-format.md`
- pi `docs/message-types.md`
- pi `docs/configuration.md`
- pi `examples/sdk/01-minimal.ts`
- pi `examples/sdk/11-sessions.ts`
- pi `examples/sdk/13-session-runtime.ts`
