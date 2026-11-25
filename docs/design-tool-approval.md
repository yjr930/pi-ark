# 删除指令审批

本文档描述 Pi-Ark 的删除指令审批能力：Agent 通过 `bash` 执行删除文件的命令时，运行暂停，用户在会话界面批准或拒绝后才继续。文档按当前实现编写，涉及 `apps/server/src/tool-approvals.ts`、`apps/server/src/agent-tools/tool-approval.ts`、`apps/server/src/agents.ts`、`apps/server/src/config.ts`、`apps/web/src/components/ToolApprovalCard.tsx` 和 `apps/web/src/components/Chat.tsx`。

## 开关

`PI_ARK_HOME/config.json` 的 `preferences.approvals.deleteCommands` 控制该功能，默认值为 `true`。Settings 的 Agent behavior 类别提供 Delete commands 开关，保存到同一个字段。审批在每次识别到删除命令时读取当前配置，因此开关改动对下一次工具调用生效，父子 Session 都使用同一份配置。

## 识别范围

审批检查 `bash` 工具收到的 `command` 字符串。识别器先按未加引号的控制操作符（`;`、`&&`、`||`、`|`、`&`、换行、括号、反引号和 `$(`）把脚本切成简单命令，再对每条命令取出命令词，因此引号里的文字、`grep` 或 `echo` 的参数不会触发检查。

识别的删除命令：

- `rm`、`rmdir`、`unlink`、`shred`，包括 `/bin/rm` 这类带路径的写法。
- `find` 带 `-delete` 或 `-exec`、`-execdir`、`-ok`、`-okdir` 后跟上述删除命令。
- `git clean` 带 `-f` 或 `--force`（`-n` 与 `--dry-run` 不触发）。
- `git rm`（带 `--cached` 时不触发）。

识别器跳过包装命令与 shell 语法再读取真正的命令：`sudo`、`doas`、`env`、`command`、`exec`、`nohup`、`time`、`nice`、`ionice`、`stdbuf`、`setsid`、`xargs`、`timeout`、`watch`、`busybox`，shell 关键字（`if`、`then`、`do`、`for`、`!` 等），变量赋值，以及 `bash -c`、`sh -c` 与 `eval` 里的脚本。

写入代码文件的删除调用（例如 Python 的 `shutil.rmtree`）在文件被执行时才产生删除，不在识别范围内。

## 运行时拦截

`AgentService` 在创建 AgentSession 时通过 `createWorkspaceResourceLoader({ extensionFactories })` 注册内部扩展。扩展监听 pi 的 `tool_call` 事件，该事件在工具执行前触发，可以阻塞调用。

扩展的处理顺序：

1. 只处理 `bash` 工具，读取 `command`。
2. 用识别器检查脚本，没有删除命令时直接放行。
3. 读取 `preferences.approvals.deleteCommands`，关闭时直接放行。
4. 调用 Server 的审批入口，等待 Promise 结算。
5. 用户批准时返回 `undefined`，工具按原参数执行；用户拒绝、运行中止或其他关闭原因时返回 `{ block: true, reason }`，pi 把 `reason` 写成该调用的错误 tool result，模型看到 `[删除审批]` 开头的说明。

脚本内嵌套调用（例如 `codemode` 脚本调用 `bash`）同样经过 `tool_call`，审批卡片挂到发起脚本的工具行。

## 审批状态

待审批项保存在 Session runtime 的 `pendingApprovals`，键为随机生成的 `approvalId`，每项包含：

- `approvalId`：审批标识，界面与接口使用该值。
- `toolCallId`：实际的 bash 调用标识。
- `anchorToolCallId`：显示卡片的工具行；普通调用是同一次 bash 调用，脚本内嵌套调用是外层脚本调用，子 Session 调用是父 Session 的 `subagent` 调用。
- `toolName`、`command`、`matched`：工具名、命令原文和识别到的删除命令。
- `sessionId`：发起命令的 Session；子 Session 的审批额外带 `sessionLink` 与 `sessionTitle`。
- `requestedAt`：请求时间。

这些状态只存在内存中，Session 重启后审批请求消失。会话 Stop、删除与回滚会结算该 Session 的待审批项，`reason` 分别为 `aborted`、`deleted` 与 `rollback`；工具调用的中止信号也会把对应审批结算为 `aborted`。子 Session 的审批登记在父 Session 上，父 Session 的这三种操作同样结算这些审批。

## 子会话转交

子 Session 执行的删除命令由父 Session 显示审批卡片，因为用户只在父 Session 的会话界面操作。`requestDeleteApproval()` 用 `SubagentStore.findTask()` 判断命令来自哪个子 Session，再从 `handles` 取出父 Session 的 runtime，把待审批项登记在父 Session 上。卡片显示子 Session 的任务标题，并提供打开该子 Session 的链接，用户可以在子 Session 页面查看上下文。

一个 `subagent` 调用委派多个任务、或多个子 Session 同时请求审批时，每个审批各占一张卡片，按请求顺序堆叠在对应的工具行内。父 Session 不存在时，审批登记在发起命令的 Session 上。

## 接口

| Method 与 path | 行为 |
|---|---|
| `POST /api/workspaces/:workspaceId/sessions/:sessionId/approvals/:approvalId/approve` | 批准该命令 |
| `POST /api/workspaces/:workspaceId/sessions/:sessionId/approvals/:approvalId/deny` | 拒绝该命令 |

Agent WebSocket 支持 `approve-tool` 与 `deny-tool` 命令，参数为 `approvalId`。审批已结算时返回 409。

Snapshot 包含 `approvals`（当前待审批项列表）与 `waitingForApproval`；历史分支视图不返回审批。Session status 包含 `waitingForApproval`。审批新增和结算都会重新发送 snapshot。

## 界面

审批卡片显示在发起命令的工具行下方，工具行本身保持原有的 Running 状态：

- 卡片 header 显示盾牌图标、`Delete command needs approval` 标题、来源说明和 `Waiting` 状态；来自子 Session 的卡片在来源说明中显示 `Subagent` 与任务标题。
- 卡片正文用等宽字体显示完整命令，下方显示识别到的删除命令；来自子 Session 时提供 `Open subagent session` 链接。
- 底部提供 `Deny` 与 `Approve`。点击后按钮进入忙碌状态，结算后卡片消失，命令继续执行或在工具行显示拒绝原因。
- 等待审批时 header status 显示 `Waiting for approval`，Session 列表中对应的 Session 显示盾牌图标；子 Session 页面的 Parent Agent 状态显示 `waiting for approval`。
- Composer 顶部显示 `A delete command is waiting for approval.` 与 `Show request`，多个审批汇总为数量，按钮滚动到第一张卡片。
- 待审批的工具调用不进入 `show more tool calls` 折叠，卡片始终可见。

卡片使用 `--fs-*` 字号变量，与 Appearance 中的字号倍率一起缩放。

## 检查

`scripts/check-tool-approval.ts` 覆盖识别器的命令分类、引号与干跑排除，以及拒绝原因文本。
