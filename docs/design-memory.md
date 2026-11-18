# Pi-Ark Memory 设计草案

**状态：待评审。** 本文提出跨 Session 的 Memory 设计。下文的界面、数据字段和工具均为提案。调研于 **2026-11-18 UTC** 核对，Claude Code 的版本基准为 **v2.1.327（2026-11-17）**。从业者文章的发表日期、实测版本和 3 个月的时效标记见 [Claude Code Memory 调研：从业者分析](research-claude-code-memory.md#从业者分析)。{[Claude Code 发布记录](https://github.com/anthropics/claude-code/releases/tag/v2.1.327)；[同版本模板快照](https://github.com/Piebald-AI/claude-code-system-prompts/releases/tag/v2.1.327)}

## 首版建议

**为每个已启用的 Workspace 提供一套经过用户确认的长期笔记。** Agent 可以建议保存或更新一条经验；用户看到内容和来源后确认。新 Session 拿到一份有限大小的目录，遇到相关任务时按需读取条目。用户可以在 Workspace 的 **Memory** 页面修订、归档或删除条目。

以下场景是首版要解决的问题：用户在一个 Session 解释了为什么报表按到账日统计，另一个 Session 生成月报时可以找到口径和原因；后来用户改用结算日，当前有效条目随之更新。上一次对话仍留在原 Session，方便查证。

## 借鉴哪些做法

| Claude Code 或从业者的做法 | Pi-Ark 的选择 | 理由 |
| --- | --- | --- |
| 官方将启动时的 `MEMORY.md` 与按需读取的主题文件分开；Anthropic 的近期研究指出，主动载入的记忆应保持简短。 | **借鉴：短目录和正文分开。** 目录由服务端生成，正文按需读取。目录优先保留用户置顶和与当前工作相关的条目。 | 新 Session 知道有哪些经验可以查；使用其他工具时，上下文仍留给当前任务。{[官方说明](https://code.claude.com/docs/en/memory#how-it-works)；[Anthropic 研究](https://www.anthropic.com/research/components-of-agent-memory)} |
| v2.1.327 的模板区分记忆类型（`user`、`feedback`、`project` 和 `reference`）；Cyril Simonnet 的使用经验强调原因、日期和原资料入口。 | **借鉴：一条记忆记录一件事。** 首版保留「偏好」「反馈」「项目事实」「参考资料」四种类型。反馈写明原因和适用条件；会变化的事实带复核日期。 | 未来的 Session 可以判断这条经验何时适用。例如，个人回复偏好和项目的报表口径有不同的变更方式。{[Memory 模板](https://github.com/Piebald-AI/claude-code-system-prompts/blob/f212301d01a776b8a0406e90fe50657bd1ec30a0/system-prompts/system-prompt-memory-instructions.md)；[Cyril 的日常用法](https://cyrilsimonnet.substack.com/p/the-memory-setup-i-actually-use-with)} |
| irosona 的盘点中，`MEMORY.md` 索引能正常定位文件，问题集中在正文中由模型填写的条目间引用。 | **改造：由程序维护条目引用和索引。** 模型提交结构化的保存建议；服务端生成条目标识。首版的来源引用采用现有的会话链接或用户提供的资料链接。 | 改标题不会切断引用；归档会更新目录。按真实条目解析引用比让模型记住文件名更可靠。{[irosona 的盘点与实测](https://zenn.dev/irosona/articles/claude-code-memory-100-entries)} |
| Claude Code 的本地 auto memory 默认开启，模型可直接写入。Gordon Beeming 记录了单次要求被误用为长期偏好的顾虑。 | **改造：Workspace 自选启用，Agent 建议、用户确认。** 先让用户控制写入内容，再根据使用情况考虑自动提取。 | 跨 Session 的内容会反复影响回答；用户最清楚一句「这次这样做」是否应变成未来的约定。{[默认值](https://code.claude.com/docs/en/memory#enable-or-disable-auto-memory)；[Gordon 的使用记录](https://gordonbeeming.com/blog/2026-09-15/experimenting-with-automatic-memory-in-codex-and-claude)} |
| Claude Code 用 Git 仓库确定本地 memory 范围。 | **改造：以 Pi-Ark 中注册的 Workspace 为范围。** 模型可在同一 Workspace 的主 Session 之间查阅共享笔记。 | 用户已经用 Workspace 区分项目。相同 Git 仓库可以注册为不同 Workspace，此时分别维护各自的经验。{[Claude Code 的存储范围](https://code.claude.com/docs/en/memory#storage-location)；[Pi-Ark 的 Workspace 注册](../apps/server/src/workspaces.ts)} |
| Max Nardit 的整理实测同时出现了正确修订和缺少原文依据的日期；Vellum Labs 的对照显示，修订时可能发现受影响的旧决定。 | **留待后续：按需整理成待审阅的改动。** 首版先提供修订、归档和来源核对。后续让 Agent 查相关原文，给出合并或替换建议和差异。 | 日常使用先积累可以评估的样本，再决定整理任务的成本和频率。{[Max 的实测](https://max.nardit.com/articles/anthropic-agent-memory-components-dreaming-memory-md)；[Vellum Labs 的对照](https://dev.to/vellumkasane/claude-code-memory-options-compared-claudemd-vs-auto-memory-vs-an-llm-wiki-30-decisions-11jp)} |

首版采用关键词搜索和有上限的目录。把全量历史做成向量索引、跨 Workspace 派发记忆、定时重写笔记和自动构建 Wiki 留到出现具体需求之后。首版改用用户确认、结构化索引和现有来源链接；这是 Pi-Ark 的产品选择。

## Memory 与现有能力的分工

| 现有能力 | 当前用途 | 首版的关系 |
| --- | --- | --- |
| 项目 `AGENTS.md` 和 Global system prompt | Pi-Ark 通过 ResourceLoader 加载项目上下文与全局指令，并提供 system prompt 预览。 | 继续保存项目规则和行为要求。Memory 提供经验和待查事实，由请求层装入；Global 预览仍展示基础提示词。{[Pi SDK 集成调研](research.md#resourceloader-与-system-prompt)；[ResourceLoader](../apps/server/src/resource-loader.ts)；[预览和运行时](../apps/server/src/agents.ts)} |
| Workspace Notebook | 每个 Workspace 都有可自由编辑的 Markdown 笔记，路径为 `<workspace>/.pi-ark/notebook.md`。 | Notebook 继续供人随手记录。需要在多个 Session 复用某段笔记时，用户可以选取内容建立 Memory 条目。{[Notebook 的交互](product-and-interaction.md#workspace-notebook)；[Notebook 存储](../apps/server/src/workspace-notebook.ts)} |
| Session、Fork、Rollback 和 Compact | SessionManager 维护 JSONL 树；模型用活动分支和压缩后的上下文；页面可展示压缩前的原始消息。 | Session 管理对话，Memory 管理用户已确认的跨 Session 条目。Rollback 撤回对话分支时保留已确认条目，用户可在 Memory 页面重新审阅和删除。{[Session 创建与恢复](architecture.md#session-创建与恢复)；[Pi 集成调研](research.md#fork-与-rollback)} |
| Subagent | 子 Session 具有独立的消息上下文，由父 Session 委派任务。 | 首版由主 Session 使用 Memory。子 Session 如需一条经验，主 Session 在委派时传入与任务有关的内容和来源。{[Subagent 架构](architecture.md#subagent)} |
| `pi-ark://` 链接 | 链接定位 Workspace、Session 或具体消息，并可固定到历史分支。 | 推荐用消息级链接给条目注明出处。Memory 用现有的消息映射生成链接，可在旧分支查看原文。{[内部链接与分支](../apps/server/src/internal-links.ts)；[SessionReader](../apps/server/src/session-reader.ts)} |

## 条目与存储

### 条目的内容

| 字段 | 用途 |
| --- | --- |
| `id`、`revision` | 服务端生成稳定的条目标识和修订号。改标题时保留标识；编辑时用修订号查出并发修改。 |
| `type`、`title`、`summary`、`tags` | `type` 表示是偏好、反馈、项目事实或参考资料；其他字段供目录显示和搜索。标题与摘要各占一行。 |
| `body` | Markdown 正文。反馈写明做法、原因和适用条件；项目事实明示适用条件；参考资料优先记录入口。正文可以说明下次应先核对的内容。 |
| `source` | 会话内保存时，由服务端生成含 `leafEntryId` 的消息链接；人工新建时可以记录资料入口或标为手工录入。链接指向来源，条目只保留经确认的归纳。 |
| `status`、`pinned`、`updatedAt`、`verifiedAt`、`reviewAfter` | 条目状态为生效、待复核或已归档。用户可以置顶生效条目；核对日期记录最近一次复核，单纯修改文字只更新编辑日期。复核期限可留空。 |

由代码或 `AGENTS.md` 已经提供的内容继续引用现行文件。Memory 优先保存文件里没有的原因、可重复使用的用户反馈和需要知道去哪里找的参考资料。对于容易变化的项目事实，首版建议按核对日加 90 天提示复核；用户可以按事实的有效期修改。待复核条目仍可在页面查看，退出自动目录和默认召回。项目日期使用 ISO 格式，让后续 Session 能还原「下周」等说法对应的时间。

### 首版存储方式

建议用 **实例数据目录中的 Workspace 文件**：启用时为 Workspace 注册记录分配一个 Memory 存储标识，在 `PI_ARK_HOME/memory/<store-id>.json` 保存条目、待确认的建议和 Workspace 设置；每条正文仍是 Markdown。Workspace 改名沿用注册记录；移除注册后留给用户选择导出或移除对应的数据。重新注册时分配新的存储标识。开发与备用实例各用自己的 `PI_ARK_HOME`，同一代码目录的注册由各实例分别管理。{设计依据：[`arkHome` 与 Workspace 配置](../apps/server/src/config.ts)；[Workspace 注册及重命名](../apps/server/src/workspaces.ts)。}

首版用一个小型存储文件统一保存条目与建议，按存储标识串行更新；每次写入比较修订号，再用同目录临时文件替换。服务端从当前数据生成目录和 Markdown 导出，省去模型手动维护正文文件与索引文件的同步工作。`MEMORY.md` 形式可用作导出格式。如果后续用户希望直接编辑多个 Markdown 文件，可以在保留条目接口的前提下更换存储方式。{设计依据：[Notebook 的串行写入方式](../apps/server/src/workspace-notebook.ts)；[从业者对索引与引用的观察](research-claude-code-memory.md#从业者分析)。}

## 保存、召回与修订

### 保存一条经验

1. 用户为 Workspace 启用 Memory 后，可以从 **Memory** 页面新建条目，也可以在主 Session 中表达「以后都按这个口径」。主 Agent 用拟议的 `memory_propose` 工具提交一条待确认的建议，内容包括摘要、正文、条目类型和候选来源。系统以当前 Workspace、所选消息和活动分支记录建议的来源。
2. 会话内显示建议卡片，用户可以修改内容、选择更新现有条目或新建，并通过界面确认。建议独立于对话回合保存，Agent 可继续回复。服务端从已登录的界面请求接收确认，检查来源和修订号；工具返回的是待确认的建议记录。
3. 确认时比较同类型的相近标题与现有记录，提示可能重复或冲突的条目。用户选定更新对象后，替换同一条的有效内容，并保存这次修改的理由与来源。针对同一建议重复提交确认时，返回首次确认的结果。

### 在 Agent 请求中召回

1. **请求前提供短目录。** 服务端在每个已启用 Memory 的主 Session 构建模型请求时，读取最新的生效条目。优先选取用户置顶的记录，然后用当前回合中最近一条用户直接输入的消息匹配标题、摘要和标签。没有命中的条目仍可通过工具查询。索引按固定顺序裁剪，每行提供条目标题、短摘要和读取所需的标识。首版将索引预算设为最多 8 条、合计 2 KiB UTF-8；这是 Pi-Ark 的初始预算。完整目录保留在 Workspace 页面和搜索入口中。
2. **在需要时读正文。** 拟议的 `memory_search` 支持在当前 Workspace 查找生效的条目；一次返回最多 5 个候选及摘要。`memory_read` 根据条目标识返回正文、适用条件、核对日期和来源；正文的单条上限初定为 8 KiB UTF-8。首版沿用已配置的模型完成选择，推荐从关键词匹配起步；用户可以直接在 Memory 页面按类型和状态查看所有记录。
3. **按来源判断。** 静态工具说明要求 Agent 把条目当作带来源的参考资料。遇到冲突时，先核对当前用户要求、项目规则和现行项目资料。发现条目过时后可以提示用户复核或提交更新建议。Web 的会话侧可显示「本轮查阅」与所用条目，表示发生了读取，最终行为由实际回答和操作判断。

### 修订、归档与来源变化

- Memory 页面提供搜索、来源查看、编辑、归档和删除。需要暂时停止参与召回的条目可归档；再次启用前确认适用条件。用户查看条目时，若服务端确认原 Session 已删除或消息已无法定位，系统将条目标记为待复核，并提示用户补充来源。外部链接由用户打开和核对。打开来源时仍使用原有 Workspace 和分支验证。
- 禁用 Memory、归档或删除条目后，下一次构建的目录和新查询以最新状态为准。已经送出的请求、会话中的答复、普通工具结果和压缩摘要属于原 Session 的历史。新建 Session 可以从最新的 Memory 开始；清理历史记录仍通过 Session 的管理入口。
- 待确认建议如果来自后来被 Rollback 的分支，卡片标记为「来自历史分支」，用户需要在 Memory 页面核对后再决定是否采用。已确认条目可以从来源链接回看历史分支。

## Pi-Ark 接入草图

| 接入位置 | 设计用途 |
| --- | --- |
| Workspace 的服务与 API | 新增 Memory 服务，使用现有的 Workspace 注册查找和登录检查。API 负责用户读写、评审建议和导出。工具根据当前 runtime 的 Workspace 定位存储范围。{现有入口：[`WorkspaceService.get`](../apps/server/src/workspaces.ts)；[API 与认证](../apps/server/src/index.ts)。} |
| `AgentService.instantiateSession()` | 为主 Session 注册拟议的 Memory 工具和宿主提供的扩展工厂，按请求检查 Workspace 设置。SDK 支持 `DefaultResourceLoader` 的 `extensionFactories`，Pi-Ark 已用它注册 MCP 和 Code Mode 的扩展。{[`AgentService`](../apps/server/src/agents.ts)；[ResourceLoader](../apps/server/src/resource-loader.ts)。} |
| Pi SDK 的 `context_with_system` | 候选实现为在请求副本中附上明确标为 Memory 的短目录，保留首个 system message 和工具声明。该 hook 在每次模型调用前触发，可修改发送的消息列表。`before_agent_start` 的提示词改动另有 Session 记录机制；首版的动态目录用请求层处理。{[Pi 的扩展文档：context_with_system](https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/docs/extensions.md#context_with_system)；本项目使用的 SDK 版本参见 [`apps/server/package.json`](../apps/server/package.json)。} |
| Session 的展示与压缩 | 动态目录只参与当次请求的构建，Session 树和前端展示使用原消息。`memory_read` 的普通工具调用及结果仍是历史的一部分。Compact 后的普通模型请求再次按当前 Workspace 读取目录；已进入历史的正文可随历史被摘要。实施前先用 SDK 验证该接入点对恢复、重试、steering 和 prompt cache 的影响。{[压缩统计和上下文投影](research.md#compact-的统计信息)；[SDK 集成研究](research.md)。} |

Memory 服务校验条目的字段和来源，并将用户在界面中的确认记录为正式写入的依据。网页、工具输出和子 Agent 的文字可以成为待核对的证据。Workspace 范围由内置工具和服务接口管理；本机的文件访问继续遵循实例现有的部署方式。选中的索引和正文随本次请求进入当前配置的模型；界面提示检查建议里的敏感内容，诊断记录优先保留状态和用量。

## 从草案到实现

| 顺序 | 交付与确认方式 |
| --- | --- |
| 先验证 SDK 的请求构建 | 用本地或模拟 provider 验证目录可见、只出现一次，且没有写入 Session 文件。覆盖同一回合中的连续工具调用、Session 恢复、Compact、重试和 steering；比较启用前后的请求布局和缓存用量。若注入会改变工具消息顺序或显著增加输入，先交付通过工具查询的方案。 |
| 再实现首版的管理与手动保存 | 完成 Workspace 开关、Memory 页面、建议与确认流程、召回和来源链接。例如用一个 Session 保存报表口径，在新 Session 中核对召回，再修改口径并检查新旧 Session 的表现。覆盖 Workspace 改名、重新注册、并发编辑、已归档条目的搜索和来源失效。 |
| 比较实际使用效果 | 用相同模型和任务，比较「关闭 Memory」「工具查询」「短目录加工具查询」。任务覆盖长期偏好、环境经验、已修订决定和不相关问题。记录找对条目的次数、需要用户重复纠正的次数、无关召回、输入 token 与等待时间。判断短目录是否值得默认参与每个请求。 |
| 再决定自动化 | 根据试用中重复出现的反馈，考虑由 Agent 在工作时提示保存，或提供一个用户主动发起的整理任务。整理读取用户选定的来源，输出拟议更新、合并和归档的差异；用户确认后更新正式条目。自动提取、向量检索和跨 Workspace 分享分别按使用证据评估。 |

**本次评审建议。** 先确认作用域采用 Workspace、建议需要用户确认、Notebook 保持独立。若接受这三个选择，下一个工作是验证请求构建和重放行为，再决定目录自动载入的默认方式。
