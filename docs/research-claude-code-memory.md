# Claude Code harness 调研：memory 的设计机制

本文以 Anthropic 的公开文档和发布记录为主，并单独标记第三方的静态提示词与设计推断。

## 资料时效

统一核对日为 **2026-11-18 UTC**，3 个月的分界日为 **2026-08-18**。核对时，npm 的 `latest` 标签和最新公开 release 均为 **v2.1.327（2026-11-17 发布）**。npm 的 `stable` 标签指向 **v2.1.311（2026-10-26 发布）**。本文采用 npm 注册表的 `time` 字段标注 Claude Code 的版本发布日期，并用官方发布记录说明相应变更。{[M12]}{[M17]}

- **现行官方文档**：2026-11-18 核对了公开说明。这个日期记录文档核对的时间；功能的首发日期另按发布证据标注。
- **近 3 个月**：公告、版本或快照发布于 2026-08-18 至 2026-11-18（含两端）。
- **超过 3 个月**：资料早于 2026-08-18，直接沿用的风险高。只有旧证据的内容留作历史参考；如果现行官方文档仍确认相应机制，则标为 **超过 3 个月；现行文档复核**。

| 机制 | 日期与版本 | 如何使用 |
| --- | --- | --- |
| `CLAUDE.md` 和 `.claude/rules/` | **现行官方文档**：2026-11-18 核对。 | 文件的位置、作用域和加载顺序以现行说明为准。{[M1]} |
| 直接读取 `AGENTS.md` | **近 3 个月**：v2.1.277（2026-09-18）加入；v2.1.281（2026-09-23）扩大适用范围。 | 按客户端版本和 `/config` 的 **Project instructions** 选项判断。{[M2]}{[M12]} |
| 按需加载的指令文件大小限制 | **近 3 个月**：v2.1.309（2026-10-22）。 | 按单文件及会话的上下文窗口大小计算，具体限额见下文。{[M1]}{[M12]} |
| Auto memory 和索引上限 | **超过 3 个月；现行文档复核**：v2.1.59（2026-02-25）已有 auto memory 和 `/memory` 的记录；v2.1.83（2026-03-24）加入 25 KB 的索引上限。 | 本地会话仍默认启用；启动时以 200 行和 25 KB 中先达到的上限为准。{[M3]}{[M12]} |
| 自定义项目目录名 | **超过 3 个月；现行文档复核**：v2.1.234（2026-08-17）。 | 会话记录和 auto memory 都使用所配置的目录名；从启动环境传入配置。{[M3]}{[M8]}{[M12]} |
| Subagent 的持久 memory | **超过 3 个月；现行文档复核**：v2.1.33（2026-02-06）加入 `memory` 字段。 | 按所选作用域使用独立目录。{[M5]}{[M12]} |
| 会话记录和恢复 | **现行官方文档**：2026-11-18 核对。 | 按现行说明定位 transcript；继续原有工作时，恢复相应的会话。{[M8]}{[M9]} |
| Context compaction 后的指令和索引 | **近 3 个月**：v2.1.311（2026-10-26）修复自动压缩后读取旧内容的问题。 | 以现行说明区分从磁盘重载的内容和会话摘要。{[M7]}{[M12]} |
| 云端 memory extraction | **近 3 个月**：v2.1.323（2026-11-12）。 | 发布记录说明 Anthropic 托管的云端会话中，压缩阈值变量对主会话和记忆提取的影响。{[M12]} |
| Remote memory | **超过 3 个月；历史记录**：v2.1.69（2026-03-04）和 v2.1.172（2026-06-10）。 | 旧记录用于了解特定场景；普通 CLI 的 auto memory 以本机存储的现行说明为准。{[M3]}{[M12]} |
| Piebald-AI 的 memory 模板 | **近 3 个月**：v2.1.327 快照（2026-11-17）。各片段标注的版本日期见正文。 | 参考模板里的指令；启用情况以官方说明和实际会话为准。{[M13]} |
| API 与 Managed Agents 的记忆功能；prompt cache | **现行官方文档**：2026-11-18 核对。 | 分别按 API 工具、托管平台的功能和服务端缓存理解；普通 CLI 另有本地 auto memory。{[M10]}{[M15]}{[M16]} |

## 机制总览

Claude Code 的 harness（模型之外负责提供工具和管理上下文的运行层）在每次请求中提供模型可见的信息。新会话从新的 context window（上下文窗口）开始。Claude Code 从文件读取项目指令和长期笔记，从会话记录恢复指定对话，并通过摘要延续超出窗口容量的工作。默认的本地 auto memory 使用文件存储：启动时载入 Markdown 索引，需要时再读取相关主题。{[M1]}{[M3]}{[M6]}{[M10]}

| 机制 | 谁维护、存在哪里 | 何时进入模型上下文 | 如何修改或移除 |
| --- | --- | --- | --- |
| 持久规则 | 人维护 `CLAUDE.md`、符合条件的 `AGENTS.md` 和 `.claude/rules/` | 启动时载入适用的指令；对子目录和有路径条件的规则按需载入 | 编辑实际生效的源文件；用 `/memory` 和 `/context all` 核对加载情况。{[M1]}{[M2]} |
| 主会话的 auto memory | Claude 在工作时维护 `~/.claude/projects/<project>/memory/` 下的 `MEMORY.md` 索引和主题文件 | 启动时最多载入索引的前 200 行或 25 KB，以先达到的上限为准；主题正文按需读取 | 用 `/memory` 找到目录，编辑或删除 Markdown。{[M3]} |
| Subagent 的持久 memory | 配置 `memory` 的专用子代理（subagent）维护独立目录 | 启动子代理时，将它自己的 `MEMORY.md` 的限额内内容加入该子代理的 system prompt | 修改相应作用域下的记忆文件，或修改该子代理的 `memory` 配置。{[M5]} |
| 会话记录（transcript） | Claude Code 持续写入本机的 `<session-id>.jsonl`，记录消息、工具调用和结果等会话数据 | `/resume` 或 `--continue` 恢复指定会话可继续使用的历史 | 受保留期管理；需要主动清理时，先区分单个会话文件和项目数据。{[M8]}{[M9]} |
| Context compaction（上下文压缩） | Claude Code 生成历史的摘要并记录在该会话中 | 接近窗口上限时自动运行，也可用 `/compact` 手动运行；此后该会话使用摘要、保留的消息和重新加载的上下文 | 可为摘要指定重点；切换任务时可用 `/clear` 开始新对话。{[M6]}{[M7]}{[M8]} |

## 持久规则：Claude Code 怎样发现并载入指令

### 文件位置和作用域

| 作用域 | 文件位置 | 用途和共享方式 |
| --- | --- | --- |
| Managed（组织） | macOS：`/Library/Application Support/ClaudeCode/CLAUDE.md`；Linux / WSL：`/etc/claude-code/CLAUDE.md`；Windows：`C:\Program Files\ClaudeCode\CLAUDE.md`。管理员也可通过 managed 或 policy settings 的 `claudeMd` 字段提供同层指令 | 管理员分发组织指引。`claudeMd` 在用户、项目和项目本地设置中无效。{[M1]} |
| User（用户） | `~/.claude/CLAUDE.md`；规则可放在 `~/.claude/rules/` | 同一用户在本机的各个项目共享。{[M1]} |
| Project（项目） | `./CLAUDE.md` 或 `./.claude/CLAUDE.md`；规则可放在 `./.claude/rules/`；`AGENTS.md` 的选择条件见下文 | 团队可以通过版本控制共享。{[M1]}{[M2]} |
| Local（项目本地） | `./CLAUDE.local.md` | 保存个人在该项目中的指令。将文件加入 `.gitignore`；未提交的本地文件只存在于建有该文件的 worktree（Git 的独立工作目录）。{[M1]} |

启动时，Claude Code 沿着当前工作目录向上查找；载入时先放组织和用户指令，再由文件系统的顶层目录向当前目录拼接项目指令。同一目录的 `CLAUDE.local.md` 接在 `CLAUDE.md` 之后。规则文件也遵循拼接规则，用户级规则先于项目级规则。靠近工作目录的指令出现在后面，发生冲突时模型可能遵循任一条。{[M1]}

Claude Code 在 system prompt 之后，以 user message 提供 `CLAUDE.md` 的内容。官方把启动时载入的指令、auto memory 索引和无路径条件的规则归入 project context（项目上下文），放在对话历史之前。要求客户端实际阻止某项操作时，应使用 `permissions.deny` 或 `PreToolUse` hook；指令文件给模型提供行为指引。{[M1]}{[M10]}

**加载选项与设置优先级。** JSON 设置中的同名标量通常按 managed → `--settings` → local → project → user 选值，列表通常合并。这套覆盖规则与 Markdown 的拼接顺序不同。`--setting-sources` 可选 `user,project,local`：排除 `project` 会跳过项目 `.claude/rules/`，排除 `local` 时，额外目录的 `CLAUDE.local.md` 也会跳过。`claudeMdExcludes` 在各设置层的列表合并，并用绝对路径的 glob 模式匹配指令文件；组织的 managed `CLAUDE.md` 不受该列表排除。若关闭整体指令加载，组织指令也可能不进入上下文，客户端执行的 managed settings 另行处理。{[M1]}{[M4]}

### 新版对 `AGENTS.md` 的支持

**近 3 个月。** Claude Code 从 **v2.1.277（2026-09-18）** 起可通过内置插件直接读取 `AGENTS.md`。**v2.1.281（2026-09-23）** 将支持范围扩展到经由其他平台访问的会话（Amazon Bedrock、Google Vertex AI、Microsoft Foundry 和 LLM gateway）以及关闭 telemetry 的会话。旧版本和停用了该插件的会话可使用 `CLAUDE.md` 中的 `@AGENTS.md` 导入。对从 v2.1.276 或更早升级的部分安装，直接读取可能从第二个会话开始。{[M2]}{[M12]}

| `/config` → **Project instructions** | 如何选择指令 |
| --- | --- |
| `claude-md-or-agents-md`（默认） | 若当前目录或任一祖先目录有 `CLAUDE.md`、`.claude/CLAUDE.md` 或 `CLAUDE.local.md`，启动时采用这些 CLAUDE 文件；否则载入沿途的 `AGENTS.md` 和 `.claude/AGENTS.md`。用户级和 managed 的 `CLAUDE.md` 以及 `.claude/rules/` 不参与此判断，可以随 `AGENTS.md` 一起载入。{[M2]} |
| `claude-md-and-agents-md` | 同一目录先放 CLAUDE 文件，再放 AGENTS 文件。已经通过导入或符号链接载入的 `AGENTS.md` 去重。依赖 `AGENTS.md` 又想保留 `CLAUDE.local.md` 时可选此项。{[M2]} |
| `claude-md` | 使用 CLAUDE 文件；需要共享 `AGENTS.md` 时，可在 CLAUDE 文件内导入。{[M2]} |
| `managed-only` | 启动时采用 managed `CLAUDE.md` 和已启用的 auto memory。子目录的 `CLAUDE.md` 和 `.claude/rules/` 以及有路径条件的规则仍可按需加载。{[M2]} |

`pluginConfigs["cc-plugin-agents-md@builtin"].options.instructionFiles` 可配置同一选项，来源为用户设置、`--settings` 或 managed settings。**近 3 个月。** v2.1.285（2026-09-29）起接受 `cc-plugin-agents-md@builtin` 和原有的 `agents-md@builtin`；早期版本使用原有的插件 ID。更改此选项从下一条消息起生效。{[M2]}{[M17]}

### 路径触发和导入

| 文件或入口 | 触发条件 |
| --- | --- |
| 子目录中的 `CLAUDE.md`、`CLAUDE.local.md` | Claude 对同一子目录中的另一个文件使用 Read、Write 或 Edit 时载入一次。可识别为单文件读取的 Bash 命令（例如 `cat` 或 `head`）也可触发。{[M1]} |
| `.claude/rules/` 或 `~/.claude/rules/` 下的 Markdown | 规则支持递归发现。无 `paths` 的项目规则随同层的 CLAUDE 指令载入。有 `paths` 的规则在 Read、Write、Edit 或可识别的 Bash 读取匹配文件时载入，例如 `src/api/**/*.ts`。项目 glob 相对于包含 `.claude/` 的目录；用户 glob 相对于会话的主工作目录。{[M1]} |
| 子目录中的 `AGENTS.md` | 默认回退模式下，官方描述的触发是 Claude 用 Read 在该子目录打开文件，而且该目录本身没有上述任一 CLAUDE 文件。直接加载功能不读取 `AGENTS.local.md`、`AGENTS.override.md` 或 `.agents/` 目录。{[M2]} |
| `--add-dir` | 默认提供额外目录的文件访问能力。设置 `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` 后，也读取该目录的 CLAUDE 文件和无 `paths` 的 `.claude/rules/`，不直接读取该目录的 `AGENTS.md`。{[M1]}{[M2]} |

`@path` 在宿主指令文件加载时展开，可以使用绝对路径；相对路径以包含该指令的文件为准。可递归导入至多 4 跳；Markdown 的行内代码和围栏代码块中的 `@path` 保持原样。项目级文件首次引用工作目录之外的文件时，Claude Code 会请求批准。直接加载的 `AGENTS.md` 也支持导入和 `claudeMdExcludes`，但外部导入要求项目已有批准，并且直接加载不触发 `InstructionsLoaded` hook；通过 `CLAUDE.md` 导入或链接的 `AGENTS.md` 按 CLAUDE 文件的方式触发该 hook。{[M1]}{[M2]}

### 上下文预算

| 内容 | 大小规则 |
| --- | --- |
| 启动时载入的 `CLAUDE.md` | 官方建议每个文件少于 200 行；文件超过 4 MiB 时，Claude Code 会跳过整个文件。`@path` 可以分开维护文件，但导入的内容一同进入上下文，仍占用 token。{[M1]} |
| 按需载入的 CLAUDE 文件及其导入、按需加载的规则 | **近 3 个月。** v2.1.309（2026-10-22）起按单文件限制自动载入的字符数。200K token 窗口对应 40 000 字符；1M token 窗口下，Opus 4.6 和 Sonnet 4.6 对应 200 000 字符，后续模型对应 150 000 字符。超过限额时会附上可用 Read 继续读取的提示。{[M1]}{[M12]} |
| `MEMORY.md` | 200 行或 25 KB 是启动读取上限，和 CLAUDE 文件的 200 行写作建议不同。应以 `/context all` 查看实际 token 用量和已载入的 memory 文件。{[M1]}{[M3]}{[M7]} |

## Auto memory：写入、复用与维护

### 什么条件下启用

**超过 3 个月；现行文档复核。** v2.1.59（2026-02-25）的发布记录已提到自动保存和 `/memory`，现行文档继续确认本地会话默认启用 auto memory。自托管环境中的会话默认关闭，Claude Tag 会话是此条默认值的例外。`-p` 本身不跳过资源发现；`--bare` 或 safe mode 默认跳过 auto memory。{[M3]}{[M4]}{[M12]}{[M14]}

`/memory` 的开关写入 `~/.claude/settings.json` 的 `autoMemoryEnabled`；项目也可在自己的设置中控制。环境变量 `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` 关闭读写，值 `0` 可覆盖 `autoMemoryEnabled: false` 或 `--bare` 的默认关闭行为。若在后台会话或由另一 Claude Code 会话启动的进程中使用 `/memory`，该开关可以关闭 auto memory；要用开关重新启用，请从终端直接启动 Claude Code。{[M3]}{[M4]}

### 路径、索引和主题文件

默认目录是 `~/.claude/projects/<project>/memory/`。Claude Code 从 Git 仓库路径确定 memory 的项目键；同一仓库的不同子目录和 worktree 共享目录。Git 仓库之外以项目根目录为准。`CLAUDE_CONFIG_DIR` 可以替换 `~/.claude`。{[M3]}{[M8]}{[M9]}

**超过 3 个月；现行文档复核。** 从 v2.1.234（2026-08-17）起，在启动 `claude` 的环境中同时设置 `CLAUDE_CONFIG_DIR` 和 `CLAUDE_CODE_PROJECT_DIR_NAME`，可以为 `projects/` 下的项目目录指定固定名称。会话记录和 auto memory 都会使用该名称。{[M3]}{[M8]}{[M12]}

`autoMemoryDirectory` 可在各设置来源中指定绝对路径或 `~/` 开头的目录。来自项目或本地设置的值遵守项目设置中 hook 所用的 workspace trust（工作区信任）规则；开启 `permissions.blockReadsOutsideWorkingDirectories` 时，Claude Code 不读写由仓库提供的设置所选的 auto memory 目录。{[M3]}{[M4]}

目录中的 `MEMORY.md` 是索引，每条记忆可放一行链接，指向存有细节的 Markdown 主题文件（例如 `feedback_testing.md`）。Claude Code 在会话启动时载入索引开头的 **200 行或 25 KB，以先达到的上限为准**；Claude 用常规文件工具按需读取主题。Claude 写完索引后，客户端检查大小：接近限额时提示缩减，超过限额时写入仍然成功，但工具会提示重写索引，超出的内容下次启动时不会自动载入。**超过 3 个月；现行文档复核。** 25 KB 的上限从 v2.1.83（2026-03-24）起与行数上限并用。{[M3]}{[M12]}

### Claude 保存什么

Claude 判断某条信息对未来会话是否有用，在工作中写入或更新文件；是否有新笔记取决于会话内容。官方列出下面的类型，存于主题文件的 Markdown frontmatter（文件开头的 YAML 元数据）。能从代码或 Git 历史恢复的细节，以及已经写在 CLAUDE 文件中的规则，通常由原有来源提供。{[M3]}{[M6]}

| `type` | 适合保留的经验示例 |
| --- | --- |
| `user` | 用户的角色、经验和工作偏好，例如评审人熟悉后端但需要解释前端术语。{[M3]} |
| `feedback` | 用户纠正或确认的做法，例如运行集成测试时使用真实的本地依赖，以及这样测试的原因。{[M3]} |
| `project` | 代码和 Git 历史看不出的工作状态、截止日期或项目决定，例如为配合某个发布安排暂缓迁移。{[M3]} |
| `reference` | 项目之外的信息入口，例如故障记录所在的工单系统或监控看板。{[M3]} |

**显式请求。** 可说“记住：这个项目的 API 集成测试需要本地 Redis”，并在 `/memory` 中核对主题文件。要改成团队指令，可直接说“把这条规则加入项目的 `CLAUDE.md`”。`/memory` 能列出文件并用编辑器打开，也能定位 auto memory 目录。Claude 写入带 YAML frontmatter 的记忆文件时，客户端会在 `modified` 字段中记录写入时间。{[M3]}

**修订、删除和同步。** 修改过时的主题文件即可更新后续读取的内容；删除一条记忆时，可以同时删除主题文件和对应的索引项。会话记录的定期清理不删除默认 `memory/` 中的笔记。关闭 auto memory 是停止读写的开关，文件的保留由编辑或删除操作决定。普通 auto memory 留在运行 Claude Code 的机器上，不随 Git worktree 共享机制跨机器或跨云环境同步。需要团队共享的规则可放在项目指令中；需要迁移个人笔记时，可核对内容后迁移索引和主题文件，并为目标环境选定目录。{[M1]}{[M3]}{[M9]}{[M14]}

## Subagent 的独立 memory

subagent 在自己的上下文窗口中接收委派任务。非 fork 的 subagent 通常加载适用的项目指令，但不载入主对话的 auto memory；内置 Explore 和 Plan 会跳过启动时的指令，配置 `omitClaudeMd` 的自定义 subagent 也可省略用户、项目和本地指令。fork 从父对话的 system prompt 和已有消息开始，因而继承已在父上下文中的记忆。{[M3]}{[M5]}

**超过 3 个月；现行文档复核。** v2.1.33（2026-02-06）加入了 subagent 的 `memory` 字段。在 subagent 定义的 YAML frontmatter 中配置 `memory`，且会话的 auto memory 已启用时，Claude Code 才加载该 subagent 的持久记忆。它会将目录读写说明和 `MEMORY.md` 的前 200 行或 25 KB 加入该 subagent 的 system prompt，并为维护记忆启用 Read、Write 和 Edit。{[M5]}{[M12]}

| `memory` 的作用域 | 目录 | 适用场景 |
| --- | --- | --- |
| `user` | `~/.claude/agent-memory/<agent-name>/` | 同一 subagent 在用户的不同项目中积累经验。{[M5]} |
| `project` | `.claude/agent-memory/<agent-name>/` | 记忆限于项目，可通过版本控制共享。{[M5]} |
| `local` | `.claude/agent-memory-local/<agent-name>/` | 记忆限于项目，适合放在版本控制之外的个人笔记。{[M5]} |

同一 subagent 的新调用可以复用上述目录。要延续它的某次工作，则恢复原有 subagent 的会话；它的 transcript 存在父会话的 `~/.claude/projects/<project>/<session-id>/subagents/agent-<agent-id>.jsonl`，主对话压缩时不改写该记录。{[M5]}{[M9]}

## 会话记录、恢复和 context compaction

以下操作依据 **现行官方文档（2026-11-18 核对）**。与重载内容有关的版本变更见压缩小节。{[M7]}{[M8]}{[M9]}

### 本地记录和恢复

默认的 transcript 是明文 JSONL，路径为 `~/.claude/projects/<project>/<session-id>.jsonl`。这里的 `<project>` 默认由启动的工作目录路径生成（非字母数字字符替换为 `-`）；因此会话的目录键与 auto memory 按仓库共享的键应分开理解。`claude --continue` 继续当前目录最近的适用会话；`claude --resume <session-id>`、`claude --resume <绝对 transcript 路径>` 和会话内的 `/resume` 则选择指定会话。{[M3]}{[M8]}{[M9]}

恢复时，Claude Code 从记录重建先前的消息和工具交互，并沿用会话 ID。若该会话已经压缩，模型继续使用最近一次的摘要、该次压缩保留的未摘要消息，以及压缩以后的消息；压缩前已被摘要替代的消息不重新进入窗口。`/branch` 或 `--fork-session` 会将历史复制到新的会话 ID。{[M6]}{[M8]}

`cleanupPeriodDays` 通常默认 30 天，最小为 1 天；Claude Desktop 和 Cowork 有单独的会话保留规则。删除单个 transcript 会影响该会话的恢复；如需删除 auto memory，要处理对应的记忆文件。项目级 `claude purge` 的范围更大，可同时删除项目数据目录中的会话和 auto memory，执行前可用 `--dry-run` 查看范围。希望本次非交互运行不写 transcript 时，可使用 `-p --no-session-persistence`。{[M8]}{[M9]}

### 压缩后如何重建上下文

上下文接近模型和配置决定的上限时，Claude Code 会自动摘要对话；也可使用 `/compact [instructions]`，或在 `CLAUDE.md` 里加入 `Compact Instructions` 指定要保留的工作信息。摘要通常保留任务目标、进度和关键代码片段，早期消息中的细节可能只剩概述。`/clear` 则开始新对话并重新载入启动上下文；默认保存的旧会话仍可用 `/resume` 恢复。{[M6]}{[M7]}{[M8]}{[M10]}{[M11]}

**近 3 个月。** v2.1.311（2026-10-26）修复了自动压缩后仍读取旧内容的问题，涉及本次会话早先编辑过的 `MEMORY.md` 和 `CLAUDE.md`。{[M12]}

| 压缩后 | 内容及来源 |
| --- | --- |
| 仍适用的配置与启动内容 | System prompt 和 output style 继续适用。项目根目录的 `CLAUDE.md`、无条件规则和 auto memory 由磁盘重新注入。项目根目录或用户级 `CLAUDE.md` 的会话中途修改可用 `/compact`、`/clear` 或重启重新加载。{[M1]}{[M7]}{[M10]} |
| 按需重新加载的内容 | 子目录的 CLAUDE 文件和含 `paths` 的规则，随再次处理匹配文件而载入。主题记忆文件仍按需读；重载 auto memory 的索引并不等于读入所有主题正文。{[M1]}{[M3]}{[M7]} |
| 重新读取的工作文件 | Claude Code 选取已读取或编辑过的文件，按最近修改排序，最多重读 5 个；超过 5000 tokens 的文件保留路径提示。Plan mode 的计划文件也可从磁盘重新注入。{[M7]} |
| 保留为摘要的内容 | 较早的对话和工具内容，以及之前 hook 添加的上下文，随历史一起摘要。匹配 `compact` 来源的 `SessionStart` hook 会再运行，把这一次的输出加入压缩后的上下文。{[M7]} |

## 示例：启动 → 工作 → 写入 → 下次或压缩后读取

以下场景用一个 API 项目说明加载顺序。{[M1]}{[M3]}{[M7]}{[M8]}

1. **启动。** 从项目根目录启动。项目的 `CLAUDE.md` 提供通用的工具约定；`MEMORY.md` 如有内容，就在限额内提供过去的笔记索引。
2. **工作。** Claude 读取 `src/api/orders.ts`。有 `paths: ["src/api/**/*.ts"]` 的规则此时进入上下文。如果它需要参考已经保存的测试经验，会读取相关主题文件。
3. **写入。** 用户确认以后运行集成测试都需要本地 Redis。Claude 可以将这条反馈写入 `feedback_api_tests.md`，并在 `MEMORY.md` 加入一行索引。当前问答仍作为会话历史保存。
4. **压缩后继续。** 执行 `/compact 保留当前修改和待验证的行为` 后，旧问答主要通过摘要延续。启动指令和索引由磁盘重新提供；再次处理匹配的 API 文件时，路径规则会按需重新载入。
5. **下次启动。** 在同一仓库的另一 worktree 开新会话，可从同一个索引找到该主题，但此时没有上一会话的消息。需要继续原有对话时，使用 `/resume` 选择原会话。

参考 Piebald 的 v2.1.327 静态快照（2026-11-17，**近 3 个月**），示例中的 `feedback_api_tests.md` 可以采用以下格式，`MEMORY.md` 中对应的一行可以写作 `- [API 集成测试使用本地 Redis](feedback_api_tests.md)`。{[M3]}{[M13]}

```markdown
---
name: api-integration-tests
description: API 集成测试需要本地 Redis
metadata:
  type: feedback
---

运行 API 集成测试时使用本地 Redis。

**Why:** 测试需要覆盖真实的缓存读写。
**How to apply:** 运行这类测试前，先确认本地 Redis 可用。
```

## 近版记录与静态提示词

### 官方记录可以确认的事项

| 问题 | 查到的证据及待核实事项 |
| --- | --- |
| 是否有 auto memory 提取流程？ | **近 3 个月。** v2.1.323（2026-11-12）的发布记录确认 Anthropic 托管的云端会话有单独的 auto memory extraction（记忆提取）路径。从该版本起，`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` 继续控制云端主会话的压缩阈值；记忆提取的阈值独立于这个变量。各模型和会话的具体触发时机仍待核实。{[M12]} |
| 是否有 Claude Code 的 memory consolidation、`autoDream` 或 `/dream`？ | **现行官方文档（2026-11-18 核对）。** 文档确认索引接近上限时会提示 Claude 整理。`autoDream` 和 `/dream` 的公开启用方式、默认值和调度规则仍待官方资料确认（发布记录核对至 v2.1.327）。静态 Dream 模板另见下文。{[M3]}{[M4]}{[M11]}{[M12]}{[M13]} |
| 是否有 remote memory？ | **超过 3 个月；历史记录。** v2.1.69（2026-03-04）提到 memory sync 的文件处理优化；v2.1.172（2026-06-10）修复远程会话访问已挂载的团队记忆库（`CLAUDE_MEMORY_STORES`）时的召回问题。旧记录可用来了解当时的场景；普通 CLI 是否跨环境共享，以 **现行官方文档（2026-11-18 核对）** 为准：auto memory 留在本机上。Remote Control 连接本机运行的同一个会话，云端新会话在另一套环境中运行。{[M3]}{[M12]}{[M14]} |

### Piebald-AI 的 v2.1.327 静态快照

**近 3 个月。** Piebald-AI 的 v2.1.327 快照发布于 **2026-11-17**，来源附有存档提交。下列片段与 v2.1.326 快照中对应的文件内容相同。每条括号中列出片段标注的版本（`ccVersion`）及该版本在 npm 的发布日期。快照用于查看提示词中的指令和变量；功能何时启用以及如何选择模板，以官方说明和实际会话为准。{[M13]}{[M17]}

- **分类和文件组织。** `Memory instructions`（片段标注的版本 v2.1.326，2026-11-16；**近 3 个月**）要求每个文件保存一条事实，以 `name` 和 `description` 供召回时判断相关性。模板列出记忆类型（`user`、`feedback`、`project` 和 `reference`）；对反馈与项目类条目，要求写明原因及适用方式。{[M13]}
- **写入时机。** `memory_write update triggers and timing`（片段标注的版本 v2.1.224，2026-08-07；**超过 3 个月；v2.1.327 快照仍收录**）要求在处理持久纠正、持续偏好或可复用的环境变化的同一回复中写入，排除只对当前任务适用的要求和短暂状态。{[M13]}
- **提取范围。** `Memory extraction recent context only`（片段标注的版本 v2.1.173，2026-06-11；**超过 3 个月；v2.1.327 快照仍收录**）提醒提取子代理只考虑最近的若干消息，消息数量由模板变量传入。{[M13]}
- **召回。** 记忆选择器（片段标注的版本 v2.1.287，2026-10-01；**近 3 个月**）要求根据文件名和描述选出明确有用的文件，最多返回 5 个，也可以返回空列表。{[M13]}
- **整理。** `Dream memory consolidation`（片段标注的版本 v2.1.296，2026-10-09；**近 3 个月**）是 Claude Code 快照中的整理模板。它要求先检查已有笔记，必要时定向查找 transcript，再合并重复内容、更新过时事实和整理索引。模板中有团队记忆的条件分支，部署情况仍以官方文档和发布记录为准。Claude Managed Agents 的 Dreams 是另有官方文档的平台功能，见下一节。{[M13]}{[M16]}

## 与 API 和 prompt cache 的区别

以下功能依据 **现行官方文档（2026-11-18 核对）**。Messages API 的工具类型标识和 Managed Agents 的 beta header 用于 API 请求；本节按文档核对日标注时效。{[M10]}{[M15]}{[M16]}

| 名称 | 保存或复用的是什么 |
| --- | --- |
| Messages API 的 `memory` tool | 应用在请求中声明 `memory_20250818`，并实现客户端的文件操作。`/memories` 是应用接收的路径前缀，实际数据由应用的目录或存储服务管理，和 Claude Code 的 `~/.claude/projects/` 各自独立。{[M15]} |
| Claude Managed Agents 的 memory stores 和 Dreams | 平台支持在会话资源中附加 memory store。Dreams 属于该平台的研究预览功能：异步读取输入的记忆库和会话记录，生成另一个整理后的库，输入库保持原样。{[M16]} |
| Prompt cache | 模型服务端短期复用完全匹配的请求前缀，以减少重复处理的成本和延迟；内容仍计入模型窗口。Claude Code 仍需提供本次所用的上下文。缓存过期不影响磁盘上的记忆和 JSONL，`/compact` 会建立新的对话前缀。{[M7]}{[M8]}{[M10]} |

## 设计推断

**推断：** 将简短索引放在启动上下文，把正文留给按需读取，可以把 Claude Code 每次启动为自动笔记支付的 token 控制在较小范围内，同时保留查看详细记录的入口。{因为 Claude Code 对启动读取的索引设置大小上限，主题正文只在相关工作用到时才读取。依据：[M3]、[M7]。}

**推断：** 修正一条经验后，最好在新会话中确认效果；如果继续旧会话，先前读入的版本仍可能出现在保留的历史或摘要中。{因为文件的修改仅决定后续从磁盘读取的内容，而恢复和压缩另行保留历史信息。依据：[M3]、[M7]、[M8]、[M10]。}

## 相关报告

- [Claude Code 的 system prompt](research-claude-code-system-prompt.md)
- [Claude Code 的 agent 间通信机制](research-claude-code-agent-communication.md)

## 来源

- **[M1]** Anthropic，How Claude remembers your project：[CLAUDE 文件位置](https://code.claude.com/docs/en/memory#choose-where-to-put-claude-md-files)、[指令的加载顺序与额外目录](https://code.claude.com/docs/en/memory#how-claude-md-files-load)、[导入](https://code.claude.com/docs/en/memory#import-additional-files)、[路径条件](https://code.claude.com/docs/en/memory#path-specific-rules)、[用户规则的顺序](https://code.claude.com/docs/en/memory#user-level-rules)、[文件排除](https://code.claude.com/docs/en/memory#exclude-specific-claude-md-files)、[managed 指令](https://code.claude.com/docs/en/memory#deploy-organization-wide-claude-md)、[消息位置](https://code.claude.com/docs/en/memory#claude-isnt-following-my-claude-md)、[按需文件的大小限制](https://code.claude.com/docs/en/memory#claude-ignores-the-end-of-my-subdirectory-claude-md)、[压缩后的指令](https://code.claude.com/docs/en/memory#instructions-seem-lost-after-compact)。
- **[M2]** Anthropic，AGENTS.md：[默认条件](https://code.claude.com/docs/en/memory#when-claude-code-reads-agents-md)、[Project instructions 的选项](https://code.claude.com/docs/en/memory#choose-which-instruction-files-load)、[版本与插件条件](https://code.claude.com/docs/en/memory#when-agents-md-support-is-unavailable)、[与 CLAUDE.md 的差别](https://code.claude.com/docs/en/memory#where-agents-md-differs-from-claude-md)、[共用文件的导入方式](https://code.claude.com/docs/en/memory#share-one-file-with-other-coding-tools)。
- **[M3]** Anthropic，Auto memory：[写入对象](https://code.claude.com/docs/en/memory#auto-memory)、[开关](https://code.claude.com/docs/en/memory#enable-or-disable-auto-memory)、[存储位置](https://code.claude.com/docs/en/memory#storage-location)、[索引读取与写入反馈](https://code.claude.com/docs/en/memory#how-it-works)、[通过 `/memory` 查看与编辑](https://code.claude.com/docs/en/memory#view-and-edit-with-%2Fmemory)。
- **[M4]** Anthropic，[设置的位置和作用域](https://code.claude.com/docs/en/settings#settings-files-and-who-they-affect)、[设置优先级](https://code.claude.com/docs/en/settings#settings-precedence)、[CLI flags](https://code.claude.com/docs/en/cli-reference#cli-flags)、[`autoMemoryEnabled`](https://code.claude.com/docs/en/settings-reference#automemoryenabled)、[`autoMemoryDirectory`](https://code.claude.com/docs/en/settings-reference#automemorydirectory)、[环境变量](https://code.claude.com/docs/en/env-vars#variables)、[bare mode](https://code.claude.com/docs/en/headless#start-faster-with-bare-mode)。
- **[M5]** Anthropic，Create custom subagents：[启用持久 memory](https://code.claude.com/docs/en/sub-agents#enable-persistent-memory)、[初始上下文](https://code.claude.com/docs/en/sub-agents#what-loads-at-startup)、[恢复和 transcript 路径](https://code.claude.com/docs/en/sub-agents#resume-subagents)、[fork](https://code.claude.com/docs/en/sub-agents#fork-the-current-conversation)。
- **[M6]** Anthropic，How Claude Code works：[agentic loop](https://code.claude.com/docs/en/how-claude-code-works#the-agentic-loop)、[会话独立性](https://code.claude.com/docs/en/how-claude-code-works#work-with-sessions)、[何时压缩](https://code.claude.com/docs/en/how-claude-code-works#when-context-fills-up)。
- **[M7]** Anthropic，Explore the context window：[启动与工作时所用的上下文](https://code.claude.com/docs/en/context-window#what-the-timeline-shows)、[压缩后保留或重载的内容](https://code.claude.com/docs/en/context-window#what-survives-compaction)、[检查实际用量](https://code.claude.com/docs/en/context-window#check-your-own-session)。
- **[M8]** Anthropic，Manage sessions：[恢复时保留的状态](https://code.claude.com/docs/en/sessions#what-a-resumed-session-restores)、[会话内的上下文命令](https://code.claude.com/docs/en/sessions#manage-context-within-a-session)、[transcript 路径](https://code.claude.com/docs/en/sessions#where-transcripts-are-stored)、[自定义项目键](https://code.claude.com/docs/en/sessions#name-the-project-directory-yourself)。
- **[M9]** Anthropic，Explore the .claude directory：[应用数据](https://code.claude.com/docs/en/claude-directory#application-data)、[自动清理和保留期](https://code.claude.com/docs/en/claude-directory#cleaned-up-automatically)、[清除本地数据](https://code.claude.com/docs/en/claude-directory#clear-local-data)。
- **[M10]** Anthropic，How Claude Code uses prompt caching：[请求层次](https://code.claude.com/docs/en/prompt-caching#how-the-cache-is-organized)、[压缩与缓存](https://code.claude.com/docs/en/prompt-caching#compacting-the-conversation)、[会话中修改 CLAUDE.md](https://code.claude.com/docs/en/prompt-caching#editing-claude-md-mid-session)、[缓存的有效期](https://code.claude.com/docs/en/prompt-caching#cache-lifetime)。
- **[M11]** Anthropic，[命令参考](https://code.claude.com/docs/en/commands#all-commands)。
- **[M12]** Anthropic，Claude Code 发布记录（[v2.1.327：核对时的最新公开 release](https://github.com/anthropics/claude-code/releases/tag/v2.1.327)）：
  - 本地 memory 和目录：[v2.1.33：subagent 的 `memory` 字段](https://github.com/anthropics/claude-code/releases/tag/v2.1.33)；[v2.1.59：auto memory 与 `/memory`](https://github.com/anthropics/claude-code/releases/tag/v2.1.59)；[v2.1.83：索引的字节限制](https://github.com/anthropics/claude-code/releases/tag/v2.1.83)；[v2.1.234：自定义项目目录名](https://github.com/anthropics/claude-code/releases/tag/v2.1.234)。
  - 项目指令和压缩：[v2.1.277：直接读取 `AGENTS.md`](https://github.com/anthropics/claude-code/releases/tag/v2.1.277)；[v2.1.281：扩大 `AGENTS.md` 的适用范围](https://github.com/anthropics/claude-code/releases/tag/v2.1.281)；[v2.1.309：按需指令的大小限制](https://github.com/anthropics/claude-code/releases/tag/v2.1.309)；[v2.1.311：自动压缩后重载旧内容的修复](https://github.com/anthropics/claude-code/releases/tag/v2.1.311)。
  - 云端和远程会话：[v2.1.323：云端记忆提取](https://github.com/anthropics/claude-code/releases/tag/v2.1.323)；[v2.1.69：memory sync 的旧记录](https://github.com/anthropics/claude-code/releases/tag/v2.1.69)；[v2.1.172：远程会话团队记忆库的旧记录](https://github.com/anthropics/claude-code/releases/tag/v2.1.172)。
- **[M13]** Piebald-AI，[v2.1.327 静态快照](https://github.com/Piebald-AI/claude-code-system-prompts/tree/v2.1.327)（2026-11-17，[存档提交](https://github.com/Piebald-AI/claude-code-system-prompts/commit/f212301d01a776b8a0406e90fe50657bd1ec30a0)）。片段来源：[Memory instructions](https://raw.githubusercontent.com/Piebald-AI/claude-code-system-prompts/v2.1.327/system-prompts/system-prompt-memory-instructions.md)；[写入时机](https://raw.githubusercontent.com/Piebald-AI/claude-code-system-prompts/v2.1.327/system-prompts/tool-description-memory-write-update-triggers-and-timing.md)；[提取采用近段历史](https://raw.githubusercontent.com/Piebald-AI/claude-code-system-prompts/v2.1.327/system-prompts/system-reminder-memory-extraction-recent-context-only.md)；[召回选择器](https://raw.githubusercontent.com/Piebald-AI/claude-code-system-prompts/v2.1.327/system-prompts/agent-prompt-determine-which-memory-files-to-attach.md)；[Dream 整理模板](https://raw.githubusercontent.com/Piebald-AI/claude-code-system-prompts/v2.1.327/system-prompts/agent-prompt-dream-memory-consolidation.md)。
- **[M14]** Anthropic，[云端会话能读取哪些本地配置](https://code.claude.com/docs/en/cloud-environments#what-carries-over-from-your-setup)、[Remote Control 的本机运行方式](https://code.claude.com/docs/en/remote-control)、[自托管环境的配置](https://code.claude.com/docs/en/self-hosted-environments-configuration#how-each-sessions-config-is-assembled)。
- **[M15]** Anthropic，Messages API：[Memory tool 的客户端读写](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool#how-it-works)、[启用工具](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool#getting-started)、[与 API compaction 配合使用](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool#using-with-compaction)。
- **[M16]** Anthropic，Claude Managed Agents：[Using agent memory](https://platform.claude.com/docs/en/managed-agents/memory)、[Dreams 的输入与输出](https://platform.claude.com/docs/en/managed-agents/dreams#how-it-works)、[开放状态](https://platform.claude.com/docs/en/managed-agents/dreams#availability)。
- **[M17]** npm，[`@anthropic-ai/claude-code` 的注册表元数据](https://registry.npmjs.org/@anthropic-ai%2fclaude-code)（`time`：各版本的发布日期；`dist-tags`：`latest` 和 `stable` 指向的版本）。
