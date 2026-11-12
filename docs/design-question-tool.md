# 交互式提问工具

本文档描述 Pi-Ark 的交互式提问能力：Agent 通过工具向用户提出带选项的问题，用户在会话里作答或放弃，答案回到 Agent 的上下文。文档按当前实现编写，涉及 `apps/server/src/questions.ts`、`apps/server/src/agent-tools/question.ts`、`apps/server/src/agents.ts`、`apps/web/src/components/QuestionCard.tsx` 和 `apps/web/src/components/Chat.tsx`。

## 工具接口

Agent 有两个提问工具，参数结构相同，一次调用是一个问题组。

| 工具 | 返回时机 | 用途 |
|---|---|---|
| `question` | 用户作答或放弃后返回 | 后续动作依赖答案 |
| `question_background` | 调用后立即返回 | 答案不影响当前正在做的工作 |

参数是 `questions` 数组，每个元素包含以下字段：

- `header`：界面上的短标题，可选。
- `question`：完整问句，必填。
- `options`：选项列表，每项包含 `label` 与可选的 `description`。
- `multiSelect`：是否允许选择多个选项，默认为单选。
- `allowCustom`：是否允许自由输入，默认允许。

工具不接受超时字段。参数规范化会丢弃空问句、没有选项的问题和重复的选项标签，一个问题组最多保留 8 个问题，每个问题最多保留 12 个选项。

`question` 的返回结果是 `{"status":"answered","answers":[{"index":0,"selected":["Summary"],"custom":""}]}`，或者 `{"status":"unanswered","reason":"...","answers":[]}`。`reason` 取值包括 `dismissed`（用户点击 Unanswered）、`user_prompt`（用户直接发送了新 message）、`aborted`（运行被停止）、`rollback`（会话回滚）、`deleted`（会话被删除）。

`question_background` 的返回结果是 `{"status":"pending","token":"Q3"}`。`token` 是会话内的短编号，供后续答案消息引用问题。

## 回答与放弃的通道

Session 正在等待 `question` 时，答案写入该工具调用的 tool result，Agent 循环在该工具返回后继续。

`question_background` 的答案无法追加成第二个 tool result，因为 tool result 与 tool call 一一对应。因此答案与放弃通知写入一条 custom message，类型为 `pi-ark.question-answer`，内容为 Agent 可读的文本，`details` 保存结构与界面使用的数据，不进入模型上下文。文本形如：

```text
[问题回答] Q3 「输出格式」请选择输出格式 → Summary；自由输入：按季度拆分
[问题取消] Q3 用户没有回答，直接发送了新的指令。问题：请选择输出格式
```

文本包含问题原文和选项标签，因此即使原始提问已经被压缩，Agent 仍然能读懂答案。答案消息用 `triggerTurn` 方式投递：Session 空闲时启动新一轮推理，正在运行时进入 Follow-up 队列，在当前回合结束后生效。

## 状态推导

问题状态全部由会话消息推导，服务重启与会话分支不需要独立的状态存储。推导规则如下：

- assistant message 中工具名为提问工具且带 `id` 的 toolCall 建立问题组，模式由工具名决定。
- 带 `pending` 结果的 toolResult 把编号写入问题组。
- 带 `answered` 或 `unanswered` 结果的 toolResult 结算阻塞问题组。
- `pi-ark.question-answer` custom message 按编号结算后台问题组。

会话回滚到答案之前时，答案消息随分支消失，问题自动回到待答状态。阻塞问题的待答状态由「存在 toolCall、没有对应 toolResult」直接推出。

进程在一次阻塞提问期间终止时，会话文件会留下没有结果的 toolCall。Server 在创建 Session 时补写一条 `unanswered`、`reason` 为 `aborted` 的 tool result，使后续模型请求的消息顺序保持完整。

## 循环行为

- 新增问题组前，Server 把仍在等待的后台问题组结算为 `unanswered`，`reason` 为 `superseded`。同一 Session 同一时刻只保留一个未结算问题组。
- 用户发送新 message 时，先把所有未结算问题结算为 `unanswered`，再投递 message。顺序保证 Agent 看到的是「提问被放弃」加上「新指令」。
- Stop、会话删除、会话回滚都先结算未结算问题。回滚在结算后中止仍在运行的回合，等待 Session 空闲再执行回滚。
- 阻塞问题在工具执行期间监听中止信号。信号中止时该工具返回 `unanswered`，因此 End Session 的运行不会留下悬挂的工具调用。
- 未结算问题存在时，Session runtime 状态带上 `waitingForAnswer`，Session 仍处于 running。

## 子会话转交

子 Session 不注册 `question` 与 `question_background`。子 Session 的系统说明要求子 Agent 在需要用户决策时结束任务，并在结果中给出 `Needs user decision` 段落，列出问题、候选选项和需要决策的原因。

父 Agent 收到该结果后，在自己的 Session 里调用提问工具。用户作答后，父 Agent 把答案作为新任务发送给同一个子 Session。用户交互只发生在父 Session，子 Session 页面不渲染问题卡片。

## 接口

HTTP routes 为答案与放弃提供直接入口：

| Method 与 path | 行为 |
|---|---|
| `POST /api/workspaces/:workspaceId/sessions/:sessionId/questions/:toolCallId/answer` | 提交 `answers` 数组 |
| `POST /api/workspaces/:workspaceId/sessions/:sessionId/questions/:toolCallId/dismiss` | 放弃整组 |

Agent WebSocket 支持两条命令：`answer-question`（带 `toolCallId` 与 `answers`）与 `dismiss-question`（带 `toolCallId`）。问题已结算时返回 409。

Snapshot 包含 `questions`，即当前 branch 的全部问题组及状态，并包含 `waitingForAnswer`。Session status 响应同样包含 `waitingForAnswer`。

## 界面

问题卡片替换普通 tool row，显示在发起提问的 assistant message 中：

- 卡片 header 显示提问图标、标题、`Answer to continue` 或 `Answer when you have time`，以及 `Waiting`、`Answered` 或 `Unanswered` 状态。
- 待答时逐个显示问题与选项。选项使用按钮，单选点击后替换选择，多选可以叠加；每个问题默认提供自由输入行。
- 底部提供 `Unanswered` 与 `Submit answers`。整组至少有一个选择或自由输入时才能提交。
- 已结算的卡片只显示问题与最终答案；放弃时显示放弃原因。
- 卡片使用 `--fs-*` 字号变量，与 Appearance 中的字号倍率一起缩放。

后台问题待答期间，会话可以继续运行，卡片保持可点击。Header status 显示 `Waiting for answer`，Session 列表中该 Session 显示提问图标。

## 检查

`scripts/check-questions.ts` 覆盖参数规范化、答案解析、状态推导与回答文本。
