# Claude Code harness 调研：agent 间的通信机制

## 资料时效

**核对日：2026-11-18 UTC。** Claude Code 的 npm `latest` 和 GitHub 最新公开 release 均为 v2.1.327（2026-11-17 发布）。npm 的 `stable` 为 v2.1.311（2026-10-26 发布）。{[A0]}

- **现行官方文档**：指 2026-11-18 核对的官方说明。核对日表示文档支持该行为的时间；功能的推出日期另行列出。正文未单独标注版本的 Claude Code 操作说明以这次核对为准。{[A1] 至 [A7]}
- **近 3 个月**：公告、版本发布或快照的日期在 2026-08-18 至 2026-11-18 之间（UTC，含首尾）。版本日期按 npm Registry 的 UTC 发布时间列出；功能的适用条件以现行官方文档为准。{[A0] [A5]}
- **超过 3 个月**：日期早于 2026-08-18 UTC。旧资料默认只作历史参考；标为 **超过 3 个月；现行文档复核** 的行为可按现行官方说明采用。
- **已过时（超过 3 个月）**：现行证据已给出替代做法，旧用法只作历史参考。

| 机制 | 日期与版本 | 如何使用 |
|---|---|---|
| 后台 subagent 的收件与回传 | **近 3 个月**：2026-11-02 v2.1.317；2026-11-17 v2.1.327。 | 向运行中的后台 agent 发消息可以更早送达；完成通知的近期修复涉及嵌套委派等特定情况。{[A0] [A1]} |
| Subagent 的续跑与重启后寻址 | **超过 3 个月；现行文档复核**：2026-03-16 v2.1.77；**近 3 个月**：2026-10-14 v2.1.299。 | 续跑用 `SendMessage`。重启并恢复原会话后，可用 ID，也可用主对话在上次压缩之后赋予的名称。{[A0] [A1]} |
| Fork 的默认启用范围 | **超过 3 个月；现行文档复核**：2026-08-13 v2.1.232（交互终端）；**近 3 个月**：2026-10-16 v2.1.302（扩展到 `claude -p`、Agent SDK、本机 Desktop 和 VS Code）。 | 按运行方式与 fork 设置判断 Claude 能否等待子 agent 的结果。{[A0] [A1] [A5]} |
| Agent Teams 的实验状态与完成通知 | **超过 3 个月；现行文档复核**：2026-02-05 v2.1.32（实验预览）；**近 3 个月**：2026-08-28 v2.1.251（空闲通知带最终答复）。 | 显式启用 Teams。队员的最终答复随空闲通知回传；任务进度仍以共享任务表和产物为准。{[A0] [A2]} |
| Teams 的任务表恢复与 mailbox 清理 | **近 3 个月**：2026-10-26 v2.1.311（任务表）；2026-11-02 v2.1.317（mailbox）。 | 会话恢复时可找回任务表；恢复后如需 in-process 队员，由 lead 启动新队员。mailbox 的修复涉及迟到消息与已删除的目录。{[A0] [A2]} |
| 跨会话消息的最低版本与空闲订阅 | **超过 3 个月；现行文档复核**：2026-08-07 v2.1.224（macOS、Linux 和 WSL 2）；2026-08-17 v2.1.234（原生 Windows）。**近 3 个月**：2026-08-19 v2.1.236（空闲订阅）。 | 按平台核对最低版本；用 `notify_when_idle` 订阅本机另一会话的状态时，双方均需达到 v2.1.236。{[A0] [A3]} |
| `SendMessage` 明文参数与 Teams 全员通知 | **近 3 个月**：2026-11-17 v2.1.327 的第三方交互 CLI 快照。**超过 3 个月**：2026-03-13 v2.1.75 的第三方静态分析。 | 点对点明文消息使用 `to` 和 `message`，可选 `summary`。旧版 `to: "*"` 广播属于历史参考；全员通知按现行文档逐个收件人发送。{[A2] [B1] [B2]} |
| TypeScript Agent SDK 的事件关联 | **近 3 个月**：2026-10-06 v0.3.292。 | 用子 agent 消息的 `agent_id` 对应任务事件的 `task_id`；续跑沿用该值。{[A5]} |

## 如何选用通信机制

| 机制 | 请求如何进入 | 状态与消息如何流转 | 结果与产物 |
|---|---|---|---|
| 普通 subagent（父会话内的委派） | 主会话用 `Agent` 提交任务；子 agent 在独立上下文中执行。 | 前台调用等待结果；后台完成时通知父会话。可用 `SendMessage` 寻址和续跑，符合条件的 subagent 也可互发消息。 | 父会话收到最终报告，中间工具调用留在子 agent 的 transcript（会话记录）里。{[A1] [A4]} |
| fork subagent（继承现有对话的委派） | 从父对话继承截至创建时的历史，并用新的任务指令启动。 | fork 在独立窗口内继续；终端里可以查看和补充指令。 | 最终结果回到父会话；fork 的后续工具调用留在自己的 transcript 里。{[A1]} |
| Agent Teams（实验性团队） | lead（团队的主会话）启动具名 teammate（队员会话），传入任务指令。 | 队员直发消息，有 Task 工具的队员还可认领共享任务。队员空闲或失败时，lead 收到通知。 | lead 汇总报告，队员通过消息传递文件路径或结论；任务表记录进度和归属。{[A2] [A4]} |
| Cross-session messaging（跨会话消息） | 已独立启动的会话用 `ListAgents` 找目标，再用 `SendMessage` 联络。 | 接收会话根据自身规则接收、暂存或拒绝；可有条件地请求下次空闲通知。 | 消息携带文本；接收方如需查看文件，要用本会话的工具访问相应存储位置。{[A3]} |

**调研推断：** 自包含的工作适合委派；需要共享任务归属和依赖的工作适合使用 Team；已经分开的会话可以用跨会话消息交换进展。{委派以报告返回为主，Team 另含任务表，跨会话通道传输文本；见 [A1] [A2] [A3]。}

下面的图按收件对象区分通信路径。两类独立会话都通过 `SendMessage` 收发模型可读的消息，Team 另外维护成员和任务状态。{[A1] [A2] [A3]}

```text
父会话 ── Agent(任务指令) ──→ subagent
      ←── 工具结果（前台）或完成通知（后台）──┘

SendMessage(收件地址, 消息)
  ├─ 同会话内的 subagent → 补充任务；符合条件时续跑原实例
  ├─ 同一 Team 的队员    → 写入队员 mailbox → 交给收件人
  └─ 其他独立会话        → 本机 socket 或跨设备服务 → 按接收方规则投递

Team 的共享任务表单独记录负责人、依赖和完成状态。
```

## Subagent：委派、完成与续跑

1. **提交任务。** Claude 根据用户请求和 subagent 的 `description` 选择角色；用户也可通过自然语言或 `@` 选择器指定角色。`Agent` 的调用字段包括 `description`（简短的任务描述）、`prompt`（本次指令）、可选的 `subagent_type`（角色类型）和 `run_in_background`。`name` 指定本次实例的通信名称，和角色类型是不同字段。CLI 的 `--agents` 和 SDK 的 `query()` 选项 `agents` 用于定义角色；定义中的 `prompt` 是该角色的系统提示，工具调用中的 `prompt` 是一次委派的指令。{[A1] [A5] [A6]}
2. **建立上下文。** 普通 subagent 从新的上下文开始，收到自己的系统提示、环境信息和本次委派指令。Claude Code 按角色和配置加载项目指令文件、Git 状态与预加载 skills；内置 Explore 和 Plan 跳过 `CLAUDE.md` 和 Git 状态快照。父对话的历史、此前读取的文件内容和主会话的 auto memory 留在父对话中。子 agent 通常从主会话的工作目录启动；需要分开修改 Git 工作区时，可以使用 `isolation: "worktree"`。{[A1]}
3. **选择等待方式。** 主对话启动的 subagent 默认在后台运行。前台调用会阻塞主对话，结束时返回结果；后台调用先返回 `status: "async_launched"`，Claude Code 在后续回合将完成报告作为自动通知送回，用户可在 `/tasks` 中查看执行情况。SDK 的阻塞调用在成功完成时返回 `status: "completed"`；后台运行用 `subtype: "task_notification"` 报告完成、失败或停止。这些运行状态与 Teams 的共享任务状态是不同的数据。前台权限请求随调用出现，后台权限请求集中呈现在主会话，并标出提出请求的 subagent。{[A1] [A5]}
4. **在运行中补充消息。** `SendMessage` 的 `to` 可寻址具名 agent 或用 agent ID 定位目标。非 fork 的 subagent 如果有 `SendMessage`，且当时至少有另一个具名 agent，启动时会收到包含 `main` 和同会话具名 agent 的名单快照。具备地址和工具的 subagent 可以向同级 agent 发消息。发起者可以在任务进行中用消息调整方向，工具权限仍由接收方的会话规则处理。{[A1] [A4]}
5. **在结束后续跑。** 再调一次 `Agent` 会创建新实例。要继续已有的实例，Claude 用 `SendMessage` 向其 agent ID 或名称发送后续指令；实例在后台沿用原 ID、历史和原来的工具集。内置 Explore 和 Plan 是单次调用型角色，返回结果时不提供可续跑的 agent ID。Claude 通过 `TaskStop` 停止的实例在该轮退出后仍可由消息唤起；用户用 `/tasks` 的 `x` 或 SDK `stop_task` 停止的实例需要先由用户在 transcript 可见时恢复。互动会话中，若同级 subagent 发起续跑，续跑的报告返回给该发起者；向其汇报链上的 agent 发消息时，Claude Code 保留原有报告去向。{[A1] [A5]}

**近期的收件与回传修复。** v2.1.317（2026-11-02，近 3 个月）让运行中的后台 agent 更早收到 `SendMessage` 的消息：正在执行的命令移到后台继续运行。v2.1.327（2026-11-17，近 3 个月）修复了非 auto 模式下的一种完成通知遗漏：发起委派的 subagent 自行退出且未读取后台 agent 的结果时，主对话也能收到完成通知。{[A0]}

**结果的来源标记。** v2.1.277（2026-09-18，近 3 个月）调整了回传格式，为 subagent 的结果加上来源标题并缩进正文；后台完成通知标为自动事件。现行文档将报告扫描的最低版本标为 v2.1.210（2026-07-14，**超过 3 个月；现行文档复核**）：harness 在父会话读取报告之前扫描仿冒控制标签或对话角色的文本。涉及工具执行时，父会话仍按自身的权限和沙箱规则处理。{[A0] [A1] [A5]}

**SDK 的事件关联。** 应用可以用 `parent_tool_use_id` 把子 agent 的流式消息关联到委派调用。TypeScript Agent SDK v0.3.292（2026-10-06，近 3 个月）起，子 agent 的 user 和 assistant 消息还带有 `agent_id`，与该子 agent 的任务事件中使用的 `task_id` 对应；续跑时沿用该值。父会话看到完成报告，SDK 应用可另外观察子 agent 的执行流。{[A5]}

**记录和兼容性。** 子 agent 的 transcript 与主对话分开保存，路径为 `~/.claude/projects/{project}/{sessionId}/subagents/agent-{agentId}.jsonl`，默认保留 30 天，按 `cleanupPeriodDays` 清理。主对话压缩后仍可用该记录。同一会话重启并恢复后，可按 ID 继续；从 v2.1.299（2026-10-14，近 3 个月）起，主对话在上次压缩之后赋予的名称也可跨重启使用。找不到名称时，可查同目录的 `agent-{agentId}.meta.json` 以定位 ID。SDK 会先用查询选项 `resume` 恢复所属会话，再在指令里指定子 agent 的 ID。{[A0] [A1] [A5]}

`Agent` 在 v2.1.63（2026-02-28，**超过 3 个月；现行文档复核**）由 `Task` 更名。权限规则中的 `Task(...)` 仍可作别名；SDK 的 `system:init` 工具列表也仍然显示 `Task`，而当前 `tool_use` 事件显示 `Agent`。旧例中的 `Agent` 工具参数 `resume` **已过时（超过 3 个月）**：v2.1.77（2026-03-16）移除了该参数，续跑使用 `SendMessage`。v2.1.277（2026-09-18，近 3 个月）移除了旧工具 `TaskOutput`；需要读取后台任务的输出文件时使用 `Read`。{[A0] [A1] [A4] [A5]}

### Fork 与前台等待

- **普通 subagent 与 fork 的区别。** fork 继承父对话已有的历史、系统提示、模型和工具池，结果仍走 subagent 的回传路径。让 Claude 创建 fork 时，SDK 工具参考使用 `Agent` 的 `subagent_type: "fork"`。终端的 `/subtask <任务>` 启动当前会话内的后台 fork；启用 agent view 时，`/fork` 复制完整会话到新的后台会话。关闭 agent view 时，`/fork` 才改为启动会话内的 fork。{[A1] [A5]}
- **切换等待方式。** 交互终端从 v2.1.232（2026-08-13，**超过 3 个月；现行文档复核**）起默认启用 fork 模式。v2.1.302（2026-10-16，近 3 个月）记录了默认启用范围的扩展（`claude -p`、Agent SDK、本机 Desktop 和 VS Code）。如果要在交互终端、VS Code 或本机 Desktop 中让 Claude 等待子 agent，可将 `CLAUDE_CODE_FORK_SUBAGENT` 设为 `0`，开启新会话后明确要求等待。`claude -p` 和 Agent SDK 可以按任务需要等待；角色定义的 `background: true` 则让该角色保持后台模式。`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` 会让 Claude 等待子 agent，同时关闭 shell 命令的后台执行。{[A0] [A1] [A5]}
- **并发调度。** 普通 subagent 默认最多嵌套到主会话以下 3 层。v2.1.217（2026-07-21，**超过 3 个月；现行文档复核**）为 `Agent` 发起的新委派加入同时运行 20 个 subagent 的默认上限。`/subtask` 和恢复已有 subagent 会占用名额，但启动时跳过这一上限检查。Team teammate 有自己的调度规则。{[A0] [A1]}

## Agent Teams：独立会话、任务表与消息

### 启动与上下文

1. **启动团队。** v2.1.32（2026-02-05，**超过 3 个月；现行文档复核**）的发布记录将 Agent Teams 列为实验预览。现行文档仍要求显式启用：在环境变量中设定 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`，或在 `settings.json` 的 `env` 中设定对应变量，再在交互会话里说明任务和所需队员。lead 调用 `Agent` 时，携带 `name` 的调用可以启动 teammate；fork 或在调用本身传入 `isolation` 时走 subagent 路径。由于 Claude 也会自行给委派命名，启用 Teams 会影响普通委派。`claude -p` 和以 Agent SDK 启动的非交互会话仍将这类委派作为普通 subagent 运行。{[A0] [A2] [A5]}
2. **为队员提供背景。** 每个 teammate 有自己的上下文窗口。队员读取普通会话使用的项目配置（`CLAUDE.md`、MCP servers 和 skills），并收到 lead 给它的启动指令。lead 的过去对话留在 lead 自己的会话里。队员可复用 subagent 的角色定义，但 in-process 与分屏套用的字段不同；例如角色定义里的 `skills` 不会为队员预加载。v2.1.327（2026-11-17，近 3 个月）修复了使用不同模型的 in-process 队员的上下文压缩（compaction）：队员按自己的模型与上下文上限压缩。{[A0] [A2]}
3. **选择用户如何查看与指导。** 默认 `in-process` 将队员放在主终端的 agent panel 中。用户用方向键选择队员，按 `Enter` 查看它的 transcript 或直接补充任务。分屏模式下，用户在队员自己的 tmux 或 iTerm2 pane 中操作；`--teammate-mode` 可选 `in-process`、`auto`、`tmux` 或 `iterm2`。`auto` 在 tmux 或 iTerm2 中选用分屏，其他终端使用 in-process。官方工具参考明确说明分屏队员由单独的 Claude Code 进程运行。权限和文件访问仍须按会话设置、工作目录与工具规则判断。{[A2] [A4] [A6]}

### 任务状态与完成通知

1. **建立任务和依赖。** lead 用 `TaskCreate` 创建任务，并可用 `TaskUpdate` 的 `taskId`、`owner` 和 `addBlockedBy` 指定归属和前置任务。`TaskList` 查看清单，`TaskGet` 查看单个任务。任务的状态是 `pending`、`in_progress` 和 `completed`；`blocked` 是由未完成的依赖产生的显示状态。前置任务标为 `completed` 后，Claude Code 会解除相应的依赖阻塞。{[A2] [A5]}
2. **分派或认领。** lead 可以指定负责人，也可以让空闲队员接续认领无人负责且未阻塞的任务。队员不会自己认领被阻塞的任务，用户或 lead 仍可指定其负责人。Claude Code 使用文件锁保护任务认领，避免多个队员同时认领同一任务。共享产物的编辑归属仍由 lead 安排；文件锁针对的是认领操作。{[A2]}
3. **确认进度与结果。** 队员更新 `TaskUpdate` 后，依赖该任务的队员才能按任务表继续。队员结束回合时，lead 可收到自动的空闲通知；v2.1.251（2026-08-28，近 3 个月）修复了最终答复未送达的问题，空闲通知现在带有队员的最终答复。队员因 API 错误结束时，lead 收到含错误文本的失败通知。空闲表示队员结束工作回合，任务是否已完成仍以任务状态和验收结果为准。官方建议在任务状态滞后时核对实际工作，并更新任务或请 lead 提醒队员。项目可用 hooks 运行检查或返回修改意见（`TeammateIdle`、`TaskCreated` 和 `TaskCompleted`）。{[A0] [A2]}

**Task 工具的可用性。** v2.1.268（2026-09-10，近 3 个月）起，官方工具参考给出了默认提供 Task 工具的模型范围（Opus 4.7、Sonnet 4.6、Haiku 4.5 及所列的早期模型）；在其他模型上可用 `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` 等方式启用。把 `CLAUDE_CODE_ENABLE_TASKS` 设为 `0` 会改用 `TodoWrite`。in-process 队员跟随主会话的 Task 工具配置；分屏队员从 v2.1.309（2026-10-22，近 3 个月）起继承 `--tools` 和命令行拒绝规则，而 `--allowedTools` 不会传给分屏队员。要让 lead 和分屏队员都读到该环境设置，可以通过 `--settings '{"env":{"CLAUDE_CODE_ENABLE_TODO_TOOLS":"1"}}'` 启动 lead。队员缺少 Task 工具时，团队改用消息协调。{[A0] [A2] [A4]}

### 队员直发、全员通知和关停

- **发送。** lead 与队员使用 `SendMessage` 给一个指定的队员发消息；队员之间也可按名称直发。现行团队文档要求全员通知时逐个收件人发送。明文工具的 `summary` 是发送方 transcript 中可选的简短标签，收件人预览的是 `message` 的首行。下面的 JSON 是 Claude 给工具的参数，用户可以直接用自然语言提出相同请求。{[A2] [A4] [B1]}

  ```json
  {"to": "finance", "message": "请确认简报使用到账日期作为统计口径。", "summary": "确认收款统计口径"}
  ```

- **接收。** Claude Code 自动向收件人投递消息，lead 无需轮询。主界面可显示运行中的队员，用户可进入队员 transcript 看进展并直接指导。工具消息携带来源标记；队员之间的消息无法代替用户批准权限请求。队员的权限提示显示在 lead 会话中。{[A2]}
- **关停。** 用户可以让 lead 请求名为 `finance` 的队员退出。lead 发送团队的结构化 `shutdown_request`；队员可以同意并退出，或拒绝并给出理由。同意后的关停可能需要等当前请求或工具调用结束。官方也记录了结构化的计划审批消息；这类消息留在 Team 内。{[A1] [A2] [A3]}

### 持久路径、恢复和并发范围

官方文档给团队使用以会话派生的名称：`session-` 后接会话 ID 的前 8 个字符。以下为默认路径。{[A2]}

| 本地记录 | 路径 | 生命周期与用途 |
|---|---|---|
| 团队配置 | `~/.claude/teams/{team-name}/config.json` | Claude Code 维护成员、会话 ID 和 pane 等运行信息。队员可从 `members` 发现其他成员；会话结束时删除团队配置目录。{[A2]} |
| 队员 mailbox | `~/.claude/teams/{team-name}/inboxes/{agent-name}.json` | 发送成功表示收件人的 mailbox 写入成功。写入失败时，发送方收到错误；读取时，Claude Code 会移除格式校验失败的条目，继续投递有效消息。mailbox 位于随团队清理的目录中。v2.1.317（2026-11-02，近 3 个月）修复了迟到消息重新创建已删除 mailbox 的问题。{[A0] [A2]} |
| 共享任务表 | `~/.claude/tasks/{team-name}/` | 会话结束后任务目录仍在，之后按 `cleanupPeriodDays` 清理。独立会话还可通过 `CLAUDE_CODE_TASK_LIST_ID` 共享任务表，这是单独的任务表设置。{[A2] [A7]} |

- **任务表的恢复。** v2.1.311（2026-10-26，近 3 个月）修复了通过 `--resume` 等入口恢复 Teams 会话后任务表显示为空的问题。{[A0]}
- **队员的恢复范围。** lead 仍在同一运行会话时，给已停止的 in-process 队员发消息可以重新启动该队员，并恢复已保存的对话。在 lead 使用 `/resume` 或 `/rewind` 恢复后，Claude Code 不会恢复 in-process 队员；此时可以要求 lead 启动新队员。分屏的单独进程和任务目录的留存是不同的行为，官方对 Teams 的恢复说明具体指向 in-process 的限制。{[A2] [A4]}
- **组织和并发。** 一个 lead 会话只关联自己的 Team，lead 身份固定，队员不能再创建自己的团队。官方未规定 teammate 人数硬上限，并建议多数任务先尝试 3–5 个队员。in-process 队员启动的子 agent 在前台运行；其后台请求可能报错，也可能改走前台，具体表现取决于启动方式。{[A2]}

## Cross-session messaging：联络已独立运行的会话

1. **发现和寻址。** 用户可运行 `/list-agents`（别名 `/peers`）确认目标，也可直接要求 Claude 找到某会话并通知它。Claude 用 `ListAgents` 发现目标，再以 `SendMessage` 发送；重名时使用列表提供的 `name [ref]` 区分。v2.1.232（2026-08-13，**超过 3 个月；现行文档复核**）起，用户还可在提示中从 `@` 选择器选会话。{[A0] [A3] [A4]}
2. **传输和接收。** 本机使用每个会话的 Unix socket，原生 Windows 使用 named pipe（命名管道）。跨机器或发往云端的消息经 Anthropic 服务；跨设备发现依赖 Remote Control 和 claude.ai 登录。忙碌会话在工具调用之间读消息，空闲会话开启新回合。消息只传递文本。接收方可用本会话的工具访问消息中提及的文件或 MCP 资源。用户可查看消息预览，并通过 `Ctrl+O` 阅读全文。{[A3]}
3. **授权和状态。** 接收方用 `crossSessionInbound` 选择处理方式（`accept`、`hold` 或 `refuse`），默认处理还取决于两边的权限模式。`isolatePeerMachines: true` 可以要求用户逐次批准发往本机以外的消息。主对话可在 `SendMessage` 中用 `notify_when_idle: true` 订阅本机另一个会话下次空闲或退出的通知（双方均需 v2.1.236 或更新版本；2026-08-19，近 3 个月）。该通知对应会话状态；业务结果仍由会话单独传回。{[A0] [A3]}

**可用性。** 现行文档列出的最低版本为 v2.1.224（2026-08-07，适用于 macOS、Linux 和 WSL 2）与 v2.1.234（2026-08-17，适用于原生 Windows）。以上两个版本日期均为 **超过 3 个月；现行文档复核**。使用 Bedrock 等第三方提供方或关闭 feature-flag fetching 时，本机消息需要 v2.1.248（2026-08-27，近 3 个月）或更高版本。长时间运行的 `claude -p` 会话也可接收消息；`--bare` 模式不创建 inbox。云端会话收到来自另一台机器的跨会话消息后，用户可以在云端 transcript 查看答复；云端会话不能通过 `SendMessage` 向该机器回复。{[A0] [A3]}

## 办公示例：汇总月度经营简报

以下流程用同一个场景说明如何从请求推进到验收。示例中的名称和文件路径用于说明分工。{依据 [A1] [A2] [A3] 构造。}

1. **先委派核对统计口径。** 主会话让普通 subagent 查阅回款表，并要求它返回统计期间、采用的日期字段和异常记录的位置。主会话同时写简报提纲。收到完成通知后，如果缺少异常说明，就用 `SendMessage` 让原 subagent 沿用它的上下文补查。若工作改成根据已经讨论的上下文撰写两版摘要，则从当前对话启动 fork，并让主会话选取返回的内容。
2. **需要反复协作时启用 Team。** lead 启动 `finance`、`ops` 和 `editor`。`finance` 负责 `brief/finance.md`，`ops` 负责 `brief/operations.md`；`editor` 的成稿任务依赖这两项，负责 `brief/monthly.md`。工作中，`ops` 用 `SendMessage` 向 `finance` 确认统计期间。各队员写完各自文件，再更新任务状态。前置任务完成后，`editor` 认领成稿任务并把结果路径发给 lead。
3. **联络已经开着的独立会话。** 如果报表提取已经在另一个会话 `data-export` 运行，就请那个会话通知 `@monthly-brief`：“回款表已经刷新，以到账日期汇总；文件位于共享目录中的 `exports/monthly.csv`。”简报会话收到文本后，从自己的工作环境核对该路径和口径。
4. **核对交付并关停。** lead 对照统计期间和任务依赖检查 `brief/monthly.md`，向用户交付文件链接和待确认事项。任务表提供进度，消息提供口径和完成说明，Markdown 文件承载最终产物。确认验收后，再由 lead 请求队员退出。

## 实现观察与待核实项

- **旧版 Teams 广播示例：超过 3 个月；历史参考。** Source Intelligence 对 v2.1.75（2026-03-13）的静态分析显示，当时 `SendMessage` 从旧的字段形式（`type`、`recipient` 和 `content`）改为另一组字段（`to`、`message` 和 `summary`），并支持用 `to: "*"` 广播。现行团队文档的全员通知做法是逐个收件人发送。{[A2] [B2]}
- **明文发送的字段（近 3 个月）。** Source Intelligence 的 v2.1.327（2026-11-17）交互 CLI 快照列出了收件人 `to`、字符串 `message` 以及可选字段（`summary` 和 `notify_when_idle`）。这份 schema 对应明文工具；启用 Teams 后的结构化消息字段留待按版本实测。{[A2] [A3] [B1]}
- **把发送和处理分开。** 官方公布了 mailbox 的 JSON 路径、验证行为和写入成功条件。应用如果需要确认某人已读、已更新任务或已生成产物，应约定回复或直接核验文件。{推断：官方的“已发送”以写入 mailbox 为准；该信号无法单独说明后续处理或恰好投递一次，见 [A2] [A3]。}

## 与 Pi-Ark 的对照

按 2026-11-18 核对的本仓库实现，Pi-Ark 的 `subagent` 将父会话的独立任务委派给持久化的子 Session。继续同一子 Session 时，父会话提供 `sessionId`；工具返回状态、结果摘录和消息链接。子 Session 有自己的上下文，并共享 Workspace 文件。子 Session 的输入由父会话发起。{[P1]}

**建议：** 若未来需要 agent 之间互相联络，可以保留现有的父子委派，并分别设计直发消息、任务状态和产物引用。{推断：Pi-Ark 已用 `sessionId` 表示续派对象；Claude Code 的团队机制将消息、任务和报告分别处理，见 [P1] [A2]。}

## 来源

官方文档 [A1] 至 [A7] 的统一核对日为 2026-11-18 UTC，文档中的版本记录与下列 npm 发布时间一并使用。

- **[A0] 官方版本记录：** [Claude Code 的 npm Registry](https://registry.npmjs.org/@anthropic-ai%2fclaude-code)（`time` 给出 UTC 发布时间，`dist-tags` 给出 `latest` 与 `stable`）；[v2.1.327 release](https://github.com/anthropics/claude-code/releases/tag/v2.1.327)（2026-11-17，近 3 个月）；[固定在 v2.1.327 的版本历史](https://github.com/anthropics/claude-code/blob/v2.1.327/CHANGELOG.md)，包括 [v2.1.32 的 Teams 预览记录](https://github.com/anthropics/claude-code/blob/v2.1.327/CHANGELOG.md#2132)（2026-02-05，超过 3 个月）与 [v2.1.77 的续跑参数迁移](https://github.com/anthropics/claude-code/blob/v2.1.327/CHANGELOG.md#2177)（2026-03-16，超过 3 个月）。
- **[A1] 官方 Subagents：** [角色创建和可用字段](https://code.claude.com/docs/en/sub-agents#configure-subagents)；[Task 旧名](https://code.claude.com/docs/en/sub-agents#restrict-which-subagents-can-be-spawned)；[前台与后台](https://code.claude.com/docs/en/sub-agents#run-subagents-in-foreground-or-background)；[命名](https://code.claude.com/docs/en/sub-agents#subagent-names)；[初始上下文与名单](https://code.claude.com/docs/en/sub-agents#what-loads-at-startup)；[报告扫描](https://code.claude.com/docs/en/sub-agents#subagent-output-scanning)；[续跑与 transcript](https://code.claude.com/docs/en/sub-agents#resume-subagents)；[重启后按名称发消息](https://code.claude.com/docs/en/sub-agents#message-a-subagent-by-name-after-a-restart)；[Fork](https://code.claude.com/docs/en/sub-agents#fork-the-current-conversation)；[嵌套](https://code.claude.com/docs/en/sub-agents#let-subagents-spawn-their-own-subagents)与[并发上限](https://code.claude.com/docs/en/sub-agents#concurrent-subagent-limit)。
- **[A2] 官方 Agent Teams：** [启用](https://code.claude.com/docs/en/agent-teams#enable-agent-teams)与[启动](https://code.claude.com/docs/en/agent-teams#how-claude-starts-agent-teams)；[显示方式](https://code.claude.com/docs/en/agent-teams#choose-a-display-mode)与[直接指导队员](https://code.claude.com/docs/en/agent-teams#talk-to-teammates-directly)；[任务认领](https://code.claude.com/docs/en/agent-teams#assign-and-claim-tasks)；[关停](https://code.claude.com/docs/en/agent-teams#shut-down-teammates)与[检查 hooks](https://code.claude.com/docs/en/agent-teams#enforce-quality-gates-with-hooks)；[架构与路径](https://code.claude.com/docs/en/agent-teams#architecture)；[复用角色定义](https://code.claude.com/docs/en/agent-teams#use-subagent-definitions-for-teammates)；[权限](https://code.claude.com/docs/en/agent-teams#permissions)；[消息与上下文](https://code.claude.com/docs/en/agent-teams#context-and-communication)；[队伍规模](https://code.claude.com/docs/en/agent-teams#choose-an-appropriate-team-size)；[恢复与其他限制](https://code.claude.com/docs/en/agent-teams#limitations)。
- **[A3] 官方跨会话消息：** [寻址与投递](https://code.claude.com/docs/en/cross-session-messaging#message-another-session)；[空闲通知](https://code.claude.com/docs/en/cross-session-messaging#get-a-notice-when-another-session-goes-idle)；[查看可联络的会话](https://code.claude.com/docs/en/cross-session-messaging#see-which-sessions-claude-can-reach)；[跨机器与云端](https://code.claude.com/docs/en/cross-session-messaging#message-sessions-on-other-machines)；[权限与控制](https://code.claude.com/docs/en/cross-session-messaging#control-inbound-messages)；[非交互会话](https://code.claude.com/docs/en/cross-session-messaging#non-interactive-sessions)；[可用性与限制](https://code.claude.com/docs/en/cross-session-messaging#availability)。
- **[A4] 官方工具参考：** [内置工具表](https://code.claude.com/docs/en/tools-reference)；[`Agent` 行为](https://code.claude.com/docs/en/tools-reference#agent-tool-behavior)；[Task 工具可用性](https://code.claude.com/docs/en/tools-reference#task-tool-availability)与[不同类型 agent 的 Task 工具](https://code.claude.com/docs/en/tools-reference#task-tracking-tools-in-subagents-and-agent-teams)。
- **[A5] 官方 Agent SDK：** [何时等待 subagent](https://code.claude.com/docs/en/agent-sdk/subagents#choose-whether-claude-waits-for-subagents)；[Fork](https://code.claude.com/docs/en/agent-sdk/subagents#forked-subagents)；[识别委派调用](https://code.claude.com/docs/en/agent-sdk/subagents#detect-subagent-invocation)；[续跑](https://code.claude.com/docs/en/agent-sdk/subagents#resume-subagents)；[TypeScript `AgentInput`](https://code.claude.com/docs/en/agent-sdk/typescript#agent)、[`TaskUpdateInput`](https://code.claude.com/docs/en/agent-sdk/typescript#taskupdate) 与 [`SDKTaskNotificationMessage`](https://code.claude.com/docs/en/agent-sdk/typescript#sdktasknotificationmessage)；[TypeScript Agent SDK 的 npm 版本记录](https://registry.npmjs.org/@anthropic-ai%2fclaude-agent-sdk)（v0.3.292 发布于 2026-10-06，近 3 个月）。
- **[A6] 官方 CLI：** [`--agents`、`--resume` 与 `--teammate-mode`](https://code.claude.com/docs/en/cli-reference#cli-flags)。
- **[A7] 官方本地记录：** [任务表及其共享设置](https://code.claude.com/docs/en/interactive-mode#task-list)；[自动清理规则](https://code.claude.com/docs/en/claude-directory#cleaned-up-automatically)。
- **[B1] 第三方交互 CLI 快照（近 3 个月）：** Source Intelligence，[v2.1.327 的 `SendMessage` 明文字段](https://changelogs.core-directive.com/prompts/2.1.327/tools/SendMessage?arm=cli#schema)（2026-11-17 版）。
- **[B2] 第三方静态分析（超过 3 个月，历史参考）：** Source Intelligence，[v2.1.75 的 `SendMessage` 改版与广播](https://changelogs.core-directive.com/v/2.1.75/e/sendmessage-tool-redesigned)（2026-03-13）。
- **[P1] 本仓库：** [Subagent 架构](architecture.md#subagent)；[委派工具定义](../apps/server/src/agent-tools/subagent.ts)。

## 相关报告

- [Claude Code harness 调研：System prompt](research-claude-code-system-prompt.md)
- [Claude Code harness 调研：Memory](research-claude-code-memory.md)
