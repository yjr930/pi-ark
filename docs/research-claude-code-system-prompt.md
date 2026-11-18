# Claude Code harness 调研：system prompt 的设计与公开来源

**调研日期：2026-11-18 UTC。** 本文以终端中的 Claude Code CLI 和 Claude Agent SDK 为主，依据官方文档、发布记录、第三方模板快照和媒体原文。调研时最新的官方发布版本为 `v2.1.327`。{[S16]}

## 结论

- **system prompt 怎么写：** Claude Code 用它定义主会话的工作角色和行为（如何完成软件工程任务、使用工具、处理风险和提供反馈）。Harness 还通过对话消息补充项目和运行时上下文，通过工具定义描述能力，并在实际调用时执行权限检查。改写 system prompt 只改变其中的提示词层。{[S1]，[S2]，[S3]，[S6]，[S7]}
- **有没有泄露版：** 有可核对的外泄事件，也有持续整理的公开模板。2026-03-31 报道的事故涉及 npm 版本 `2.1.88` 的 source map，可以还原该版本的客户端源码。[Piebald 的 `v2.1.326` 版本快照](https://github.com/Piebald-AI/claude-code-system-prompts/blob/5086ce6b51472d6c9a68326ac175718e271c7bd9/README.md#prompts) 来自常规发布包中的编译产物，可以直接查看提示词文本。模板按用途和条件选用，实际请求还包含会话的动态内容。{[S9]，[S12]，[S13]}

## 官方文档：harness 如何给模型提供上下文

Anthropic 在 [The agentic loop](https://code.claude.com/docs/en/how-claude-code-works#the-agentic-loop) 中把 agentic harness 定义为模型外面的运行层，负责提供工具并管理模型看到的上下文。模型在循环里收集上下文、采取行动并验证结果。工具把结果送回对话，模型据此决定下一步。{[S1]}

下图是按请求和会话范围绘制的概念图。字段名称取自公开的 Messages API，图中展示各字段的用途。{[S1]，[S2]，[S3]，[S5]，[S6]，[S7]，[S8]}

```text
Claude Code harness（主会话）
  ├─ 请求体 system   会话的基础指令：内置提示词，或自定义替换文本；可追加指令
  ├─ 请求体 messages 对话：任务、历史、工具结果，以及样式和项目指令等运行时上下文
  └─ 请求体 tools    工具定义：可用的工具及其调用方式；部分定义按需加载
                         ↓
                     Claude 模型
                         ↓ 提出工具调用
  由 harness 处理权限和 hooks → 执行工具（适用的 shell 命令由 OS 沙箱隔离）
                         └──────── 工具结果回到对话 ────────┘

  其他调用范围：普通子代理使用自己的上下文和 system prompt；fork 子代理继承父会话。
```

- **基础指令。** Claude Code 有完整和较短的内置 system prompt，选择取决于模型和配置。完整版本包含软件工程指令，例如如何控制修改范围和验证结果；较短版本省略该段，也会简化工具描述。`CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT=0` 选择完整版本。两种版本均支持相同的完整工具集以及 hooks、MCP 和 `CLAUDE.md` 的发现机制。{[S3]，[S4]，[S8]}
- **对话上下文。** Claude Code 将 `CLAUDE.md` 的内容放入 system prompt 之后的用户消息。CLI 文档将它和 auto memory 都归为供模型参考的上下文。启用 auto memory 时，启动阶段载入 `MEMORY.md` 的前 200 行或 25 KB，以先达到的上限为准；主题文件按需读取。这里要区分记忆文件中的内容与指导模型如何使用记忆的提示词。活跃的 output style 和 hook 返回的 `additionalContext` 等也可随对话进入上下文。官方 SDK 文档说明，system reminder 可以出现在用户消息的 `<system-reminder>` 标签里，也可以在部分模型上作为独立的 `system` 角色消息出现。两种形式都位于 `messages` 数组。{[S3]，[S5]}
- **工具定义。** 在公开的 Messages API 中，`tools` 是请求体顶层字段。普通自定义工具的定义包含名称、描述和参数的 JSON Schema；描述可以携带如何选用工具的指令。Claude Code 默认按需加载 MCP 工具的完整定义。CLI 的 `--tools` 选择内置工具；`--allowedTools` 设置可免于询问的调用规则。非 fork 子代理可以有自己的工具集合；自定义子代理的 Markdown 正文是该子代理的 system prompt。{[S1]，[S2]，[S6]，[S8]}
- **执行控制。** 当模型提出调用时，Claude Code 根据权限模式和规则决定是否执行或询问用户。权限规则按拒绝（`deny`）、询问（`ask`）、允许（`allow`）的顺序匹配。`PreToolUse` hook 可以阻止调用；设置内的拒绝和询问规则仍适用。启用沙箱时，操作系统对受沙箱约束的 shell 命令及其子进程执行文件系统和网络限制。提示词中的工具建议和安全措辞为模型提供指导，执行限制由这套机制负责。{[S5]，[S7]}

**请求前缀与 prompt cache。** API 按请求前缀复用缓存。Claude Code 将变化较少的内容放在前面：先是基础指令与工具定义，随后是项目上下文，然后是不断增补的对话。改变基础指令会影响后续前缀的匹配；在对话末尾增加 tool result 或 reminder 时，前面的内容可以继续命中缓存。{[S16]}

## 官方支持的自定义入口

| CLI 参数 | 对主会话 system prompt 的作用 |
| --- | --- |
| `--system-prompt` | 用传入的文本替换默认 system prompt。 |
| `--system-prompt-file` | 用文件内容替换默认 system prompt。 |
| `--append-system-prompt` | 在默认或已替换的 system prompt 末尾追加文本。 |
| `--append-system-prompt-file` | 在默认或已替换的 system prompt 末尾追加文件内容。 |

这些参数在交互模式和 `-p` 模式中均可用。CLI 支持组合替换和追加；从 `v2.1.283` 起，同一种参数的文件形式和文本形式也可一起传入，追加时文件内容在前。替换会去掉默认 system prompt 中的工具指导和安全指令；实际工具定义、上下文注入和权限控制仍按各自的配置运行。{[S2]，[S3]，[S7]}

常规会话默认记录第一次请求的 system prompt，并在会话压缩前继续复用。此时通过 `--resume` 或 `--continue` 恢复会话并更换参数，新的文本会在压缩后生效。`--system-prompt-snapshot off` 让每次请求重新构建提示词；官方文档另列了 bare mode 的记录规则。用于 `-p` 脚本的 `--exclude-dynamic-system-prompt-sections` 则把默认 system prompt 中的部分用户相关内容（例如 auto memory 的位置）移到第一条用户消息，以便不同用户复用提示词缓存。显式替换 system prompt 时，此参数不生效。{[S2]，[S3]}

**Output styles。** 适合给主会话设定角色、语气或格式；harness 在每次请求中提供活跃样式的指令。当前官方文档将样式正文列为对话中的 system reminder。对于完整 system prompt，自定义样式默认会省略内置的软件工程指令段；样式文件的 frontmatter 可用 `keep-coding-instructions: true` 保留该段。样式作用于主会话和继承它的 fork 子代理。{[S3]，[S4]}

**版本记录。** Anthropic 的 `v2.1.98` 发布说明记录了动态段缓存参数。同版本的 Piebald 快照已经包含 `Output style active` reminder，内容是样式名称和遵循样式的提示。该片段与完整的样式正文是不同的文本，不能据此确定正文首次迁入对话的版本。官方文档还记录了 `v2.1.251` 的另一项变化：会话内切换样式后，从下一条消息开始生效，此前需要 `/clear` 或新会话。{[S4]，[S11]}

**Agent SDK。** 省略 TypeScript 的 `systemPrompt` 或 Python 的 `system_prompt` 时，SDK 使用包含基本工具调用指导的最小提示词。它不同于默认使用 Claude Code 提示词的 `claude -p`。需要 CLI 的工具用法和安全指导时，可使用 `systemPrompt: { type: "preset", preset: "claude_code" }`，并在该对象中用 `append` 增补内容；也可传字符串，采用自定义的 system prompt。`CLAUDE.md` 的载入由 `settingSources` 控制，与是否选择 `claude_code` preset 分开。现行 `query()` 的默认选项启用用户和项目来源。{[S3]}

**最小示例（示意，参数由官方支持）。** 保留内置编码指令，为本次调用增加回复要求。需要跨会话共享回复风格时，可改用 output style；需要共享项目约定时，可写入 `CLAUDE.md`。{[S2]，[S4]，[S5]}

```bash
claude -p --append-system-prompt '请用中文先给结论，再说明依据。' 'Git worktree 有什么用途？'
```

## 第三方快照：模板如何随条件变化

[Piebald-AI/claude-code-system-prompts 的 `v2.1.326` 快照](https://github.com/Piebald-AI/claude-code-system-prompts/tree/5086ce6b51472d6c9a68326ac175718e271c7bd9) 对应 2026-11-16 的存档提交。维护者说明，他们从 npm 发布包的编译代码中抽取片段。仓库分别索引主 system prompt 片段、工具描述、对话提醒、子代理与辅助任务的提示词，以及技能和数据文本。Explore 和 Plan 子代理、对话压缩和会话标题生成各有自己的调用用途。{[S9]}

| 固定版本中的模板 | 可观察到的设计 |
| --- | --- |
| **Harness instructions**（主 system prompt 片段） | 开头调用 `INTERACTIVE_AGENT_INTRO_FN(INTRO_VARIANT)` 选择角色说明。对 system reminder 的解释通过 `SYSTEM_REMINDER_TAG_GUIDANCE_FN` 接收 `EXPLAINS_SYSTEM_TURNS` 参数。固定文字则规定终端 Markdown 的输出形式、独立工具调用可以并行以及代码位置可以写为 `file_path:line_number`。这把同一套工作指导与可能变化的会话能力分开。{[S10]} |
| **Agent: when to launch subagents**（工具描述） | 当 `CAN_FORK_CONTEXT` 为真时，描述会告诉模型如何用 `subagent_type: "fork"` 继承对话；其他分支只介绍新建子代理的用法。`HAS_GENERAL_PURPOSE_AGENT` 又控制是否把通用子代理写为默认选项。这里变化的是模型收到的工具说明。{[S10]} |
| **File truncated**（对话提醒） | 文件截断时，模板引用文件名和行数上限。`ATTACHMENT_OBJECT.restCannotBeRead` 决定提示「本会话无法继续读取」还是提示用读取工具获取后续内容。同一事件的提示词会随该次附件的状态变化。{[S10]} |

**可以直接读的原文。** [Harness instructions](https://github.com/Piebald-AI/claude-code-system-prompts/blob/5086ce6b51472d6c9a68326ac175718e271c7bd9/system-prompts/system-prompt-harness-instructions.md) 用 “Prefer the dedicated file/search tools over shell commands when one fits.” 说明工具选择；同一模板还要求以 `file_path:line_number` 引用代码位置。编码指令的 [Doing tasks: no unnecessary additions](https://github.com/Piebald-AI/claude-code-system-prompts/blob/5086ce6b51472d6c9a68326ac175718e271c7bd9/system-prompts/system-prompt-doing-tasks-no-unnecessary-additions.md) 则把控制任务范围写成具体行为，例如避免用户未要求的功能和重构。{[S9]，[S10]}

**写法建议（推断）。** 编写类似的 harness 时，可以把长期适用的角色、工具选择规则和输出格式放进 system prompt，把工具参数放进 schema，把工作目录、文件截断等随运行变化的信息作为对话上下文交给模型。{官方运行时使用这些不同位置，且缓存按请求前缀匹配；两者结合可以保留可复用的基础指令，并单独更新会话信息。参见 [S3]、[S6]、[S10]、[S16]。}

**`tks` 的含义。** 例如 README 将 `Harness instructions` 标为 **324 tks**。在该版本的更新脚本中，新建或正文变更的模板会先重建成文本，再以一条用户消息提交给 Anthropic 的 token counting API（模型为 `claude-sonnet-4-5-20250929`）；`tks` 取返回的 `input_tokens`，未变更的正文可以沿用已有数字。{[S9]，[S10]}

**推断：** 用 `tks` 比较静态片段的量级；估算会话成本时，以实际请求的输入和缓存用量为准。{仓库按独立的重建模板计数，而一次请求只使用与当前调用匹配的片段，并填入动态值、带上会话内容。参见 [S1]、[S3]、[S8]、[S9]、[S10]。}

## 历史记录：公开摘录、意外公开和官方发布

Source map 是编译产物到源文件的映射数据。它还可以包含源文件内容（[`sourcesContent`](https://tc39.es/ecma426/#json-sourcesContent)），这时可以从映射数据中还原相应文件。{[ECMA-426 Source Map Format](https://tc39.es/ecma426/)}

| 资料 | 能核对什么 |
| --- | --- |
| **2025 年 2 月的早期 CLI source map** | 开发者 Dave Schumaker 在 2025-02-27 记录了自己在 `cli.mjs` 中发现内联 source map 的过程。文章附有指向 npm `0.2.8` 包的本地缓存记录和源码截图。他称更新后内联映射消失。这是当事开发者的观察记录。{[S14]} |
| **2025 年的常规发布包摘录** | Piebald 在 2025-11-19 的存档提交中已公开 `v2.0.14` 的模板索引，早于 2026 年的 npm 事故。仓库现行的提取说明指向编译后的 npm 发布包，可作为版本化的模板来源。{[S9]，[S14]} |
| **2026-03-31 的 npm 发布事故** | Ars Technica 与 The Verge 的同日报道均指向 `@anthropic-ai/claude-code` 版本 **`2.1.88`**，并指出 npm 发布物中的 source map 可还原大量 CLI 的 TypeScript 源码。Anthropic 发言人向 The Verge 确认：发布包因人为原因带入了部分内部源代码；按公司的声明，事故未涉及或暴露敏感的客户数据或凭证，也不属于安全入侵。GitHub 的官方版本 tag 确认版本编号；GitHub 的 DMCA 档案记录了 Anthropic 对转载内容的下架通知，以及 2026-04-01 对通知的部分撤回。{[S12]，[S13]} |
| **Anthropic 主动公开的消费者产品 system prompts** | 官方发布页公布 `claude.ai` 聊天界面及 Claude 移动端的核心提示词，并注明这些提示词更新不适用于 Claude API。这是另一套产品界面的发布记录，可用于对照提示词写法。{[S15]} |

**如何核对某一次请求。** 模板快照回答「发布物里有哪些文字」，source map 事故提供了特定版本的客户端实现材料。对于实际生效的客户端输入，官方建议先用 `/context` 查看分类用量；如需查看文本，可在自己的 SDK 会话中用官方记录功能 `OTEL_LOG_RAW_API_BODIES=file:<dir>` 检查发出的请求体。SDK 的常规消息流省略 system reminders。检查请求体时，应分别查看顶层 `system`、对话 `messages` 和工具 `tools`。HTTP 请求头是 API 另行定义的字段。Anthropic 公开说明 API 会按 tool 定义和配置组装工具使用指令；这份调研未核验具体请求经过供应商或服务端后的完整输入。{[S3]，[S6]，[S8]}

## 相关报告

- [Claude Code harness：Agent 之间的通信机制](research-claude-code-agent-communication.md)
- [Claude Code harness：memory 的设计机制](research-claude-code-memory.md)

## 来源

### Anthropic 官方文档

- S1 — [How Claude Code works：The agentic loop](https://code.claude.com/docs/en/how-claude-code-works#the-agentic-loop)、[Context Claude Code adds on its own](https://code.claude.com/docs/en/how-claude-code-works#context-claude-code-adds-on-its-own)、[When context fills up](https://code.claude.com/docs/en/how-claude-code-works#when-context-fills-up)。
- S2 — CLI reference：[System prompt flags](https://code.claude.com/docs/en/cli-reference#system-prompt-flags)、[System prompt flags in resumed conversations](https://code.claude.com/docs/en/cli-reference#system-prompt-flags-in-resumed-conversations)、[CLI flags](https://code.claude.com/docs/en/cli-reference#cli-flags)。
- S3 — Agent SDK：[How system prompts work](https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts#how-system-prompts-work)、[CLAUDE.md files for project-level instructions](https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts#claude-md-files-for-project-level-instructions)、[Context Claude Code adds outside the system prompt](https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts#context-claude-code-adds-outside-the-system-prompt)、[See what Claude received](https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts#see-what-claude-received)。
- S4 — Output styles：[How output styles work](https://code.claude.com/docs/en/output-styles#how-output-styles-work)、[Frontmatter reference](https://code.claude.com/docs/en/output-styles#frontmatter)、[Change your output style](https://code.claude.com/docs/en/output-styles#change-your-output-style)。另见 [Prompt caching：Changing output style](https://code.claude.com/docs/en/prompt-caching#changing-output-style)。
- S5 — Memory：[CLAUDE.md vs auto memory](https://code.claude.com/docs/en/memory#claude-md-vs-auto-memory)、[How auto memory works](https://code.claude.com/docs/en/memory#how-it-works)、[Claude isn't following my CLAUDE.md](https://code.claude.com/docs/en/memory#claude-isn%E2%80%99t-following-my-claude-md)。
- S6 — Messages API：[请求参考](https://platform.claude.com/docs/en/api/messages/create)（请求体字段：[system](https://platform.claude.com/docs/en/api/messages/create#create.system)、[messages](https://platform.claude.com/docs/en/api/messages/create#create.messages)、[tools](https://platform.claude.com/docs/en/api/messages/create#create.tools)）。Define tools：[Specifying client tools](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools#specifying-client-tools)、[Tool use system prompt](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools#tool-use-system-prompt)。
- S7 — Permissions：[Manage permissions](https://code.claude.com/docs/en/permissions#manage-permissions)、[Extend permissions with hooks](https://code.claude.com/docs/en/permissions#extend-permissions-with-hooks)；Sandboxing：[How sandboxing relates to permissions and permission modes](https://code.claude.com/docs/en/sandboxing#how-sandboxing-relates-to-permissions-and-permission-modes)。
- S8 — [Environment variables：`CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT`](https://code.claude.com/docs/en/env-vars#variables)、[Subagents：Configure subagents](https://code.claude.com/docs/en/sub-agents#configure-subagents)、[What loads at startup](https://code.claude.com/docs/en/sub-agents#what-loads-at-startup)、[Fork the current conversation](https://code.claude.com/docs/en/sub-agents#fork-the-current-conversation)、[Explore the context window：Check your own session](https://code.claude.com/docs/en/context-window#check-your-own-session)。
- S15 — [System prompts：官方消费者产品的提示词发布页](https://platform.claude.com/docs/en/release-notes/system-prompts/overview)。
- S16 — [Prompt caching：How the cache is organized](https://code.claude.com/docs/en/prompt-caching#how-the-cache-is-organized)；[Claude Code `v2.1.327` 发布记录](https://github.com/anthropics/claude-code/releases/tag/v2.1.327)。

### 第三方模板与版本对照

- S9 — Piebald 的 [`v2.1.326` 存档提交](https://github.com/Piebald-AI/claude-code-system-prompts/commit/5086ce6b51472d6c9a68326ac175718e271c7bd9)、[README：Extraction](https://github.com/Piebald-AI/claude-code-system-prompts/blob/5086ce6b51472d6c9a68326ac175718e271c7bd9/README.md#extraction)、[README：Prompts](https://github.com/Piebald-AI/claude-code-system-prompts/blob/5086ce6b51472d6c9a68326ac175718e271c7bd9/README.md#prompts)。
- S10 — 同一存档提交的模板：[Harness instructions](https://github.com/Piebald-AI/claude-code-system-prompts/blob/5086ce6b51472d6c9a68326ac175718e271c7bd9/system-prompts/system-prompt-harness-instructions.md)、[Agent: when to launch subagents](https://github.com/Piebald-AI/claude-code-system-prompts/blob/5086ce6b51472d6c9a68326ac175718e271c7bd9/system-prompts/tool-description-agent-when-to-launch-subagents.md)、[File truncated](https://github.com/Piebald-AI/claude-code-system-prompts/blob/5086ce6b51472d6c9a68326ac175718e271c7bd9/system-prompts/system-reminder-file-truncated.md)。README 的计数实现：[API 调用](https://github.com/Piebald-AI/claude-code-system-prompts/blob/5086ce6b51472d6c9a68326ac175718e271c7bd9/tools/updatePrompts.js#L43-L72)、[模板重建与复用已有计数](https://github.com/Piebald-AI/claude-code-system-prompts/blob/5086ce6b51472d6c9a68326ac175718e271c7bd9/tools/updatePrompts.js#L313-L367)。
- S11 — [Anthropic 的 `v2.1.98` 发布说明](https://github.com/anthropics/claude-code/releases/tag/v2.1.98)；[Piebald 同版本存档中的 Output style active](https://github.com/Piebald-AI/claude-code-system-prompts/blob/a23620e83e8e54eb040dbc05bb208b09c9605870/system-prompts/system-reminder-output-style-active.md)。

### 事件报道与公开记录

- S12 — [Ars Technica：npm 版本和 source map](https://arstechnica.com/ai/2026/03/entire-claude-code-cli-source-code-leaks-thanks-to-exposed-map-file/)、[The Verge：事件经过与 Anthropic 发言人的书面回应](https://www.theverge.com/ai-artificial-intelligence/904776/anthropic-claude-source-code-leak)，均发表于 2026-03-31。
- S13 — [Anthropic 官方仓库的 `v2.1.88` tag](https://github.com/anthropics/claude-code/releases/tag/v2.1.88)；GitHub DMCA 档案中的 [Anthropic 下架通知](https://github.com/github/dmca/blob/master/2026/03/2026-03-31-anthropic.md)和[部分撤回](https://github.com/github/dmca/blob/master/2026/04/2026-04-01-anthropic-retraction.md)。
- S14 — [Dave Schumaker：Digging into the Claude Code source](https://daveschumaker.net/digging-into-the-claude-code-source-saved-by-sublime-text/)，发表于 2025-02-27；Piebald 的 [2025-11-19 存档提交](https://github.com/Piebald-AI/claude-code-system-prompts/commit/8b3c5741115b90dfb6da450a3dbe5e9ca8f6533f)及其 [`v2.0.14` 片段索引](https://github.com/Piebald-AI/claude-code-system-prompts/blob/8b3c5741115b90dfb6da450a3dbe5e9ca8f6533f/README.md#prompts)。
