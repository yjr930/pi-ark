# Claude Code harness 调研：memory 的设计机制

调研日期：2026-11-18 UTC。本文以 Anthropic 的公开文档和发布记录为主，并单独标记第三方的静态提示词与设计推断。

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

Claude Code **v2.1.277 起**可通过内置插件直接读取 `AGENTS.md`。旧版本和停用了该插件的会话可使用 `CLAUDE.md` 中的 `@AGENTS.md` 导入。对从 v2.1.276 或更早升级的部分安装，直接读取可能从第二个会话开始。v2.1.281 修正了此前 Amazon Bedrock 或关闭 telemetry 等会话无法直接读取的情况。{[M2]}

| `/config` → **Project instructions** | 如何选择指令 |
| --- | --- |
| `claude-md-or-agents-md`（默认） | 若当前目录或任一祖先目录有 `CLAUDE.md`、`.claude/CLAUDE.md` 或 `CLAUDE.local.md`，启动时采用这些 CLAUDE 文件；否则载入沿途的 `AGENTS.md` 和 `.claude/AGENTS.md`。用户级和 managed 的 `CLAUDE.md` 以及 `.claude/rules/` 不参与此判断，可以随 `AGENTS.md` 一起载入。{[M2]} |
| `claude-md-and-agents-md` | 同一目录先放 CLAUDE 文件，再放 AGENTS 文件。已经通过导入或符号链接载入的 `AGENTS.md` 去重。依赖 `AGENTS.md` 又想保留 `CLAUDE.local.md` 时可选此项。{[M2]} |
| `claude-md` | 使用 CLAUDE 文件；需要共享 `AGENTS.md` 时，可在 CLAUDE 文件内导入。{[M2]} |
| `managed-only` | 启动时采用 managed `CLAUDE.md` 和已启用的 auto memory。子目录的 `CLAUDE.md` 和 `.claude/rules/` 以及有路径条件的规则仍可按需加载。{[M2]} |

`pluginConfigs["cc-plugin-agents-md@builtin"].options.instructionFiles` 可配置同一选项，来源为用户设置、`--settings` 或 managed settings。v2.1.285 之前的插件 ID 是 `agents-md@builtin`；此后的版本接受两个 ID。更改此选项从下一条消息起生效。{[M2]}

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
| 按需载入的 CLAUDE 文件及其导入、按需加载的规则 | v2.1.309 起按单文件限制自动载入的字符数。200K token 窗口对应 40 000 字符；1M token 窗口下，Opus 4.6 和 Sonnet 4.6 对应 200 000 字符，后续模型对应 150 000 字符。超过限额时会附上可用 Read 继续读取的提示。{[M1]} |
| `MEMORY.md` | 200 行或 25 KB 是启动读取上限，和 CLAUDE 文件的 200 行写作建议不同。应以 `/context all` 查看实际 token 用量和已载入的 memory 文件。{[M1]}{[M3]}{[M7]} |

## Auto memory：写入、复用与维护

### 什么条件下启用

本地会话默认启用 auto memory。发布记录从 v2.1.59 起列出自动保存和 `/memory`。自托管环境中的会话默认关闭，Claude Tag 会话是此条默认值的例外。`-p` 本身不跳过资源发现；`--bare` 或 safe mode 默认跳过 auto memory。{[M3]}{[M4]}{[M12]}{[M14]}

`/memory` 的开关写入 `~/.claude/settings.json` 的 `autoMemoryEnabled`；项目也可在自己的设置中控制。环境变量 `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` 关闭读写，值 `0` 可覆盖 `autoMemoryEnabled: false` 或 `--bare` 的默认关闭行为。若在后台会话或由另一 Claude Code 会话启动的进程中使用 `/memory`，该开关可以关闭 auto memory；要用开关重新启用，请从终端直接启动 Claude Code。{[M3]}{[M4]}

### 路径、索引和主题文件

默认目录是 `~/.claude/projects/<project>/memory/`。Claude Code 从 Git 仓库路径确定 memory 的项目键；同一仓库的不同子目录和 worktree 共享目录。Git 仓库之外以项目根目录为准。`CLAUDE_CONFIG_DIR` 可以替换 `~/.claude`；从 v2.1.234 起，在启动进程的环境中同时设置 `CLAUDE_CONFIG_DIR` 和 `CLAUDE_CODE_PROJECT_DIR_NAME`，可以给 `projects/` 下的项目目录指定固定名称。{[M3]}{[M8]}{[M9]}

`autoMemoryDirectory` 可在各设置来源中指定绝对路径或 `~/` 开头的目录。来自项目或本地设置的值遵守项目设置中 hook 所用的 workspace trust（工作区信任）规则；开启 `permissions.blockReadsOutsideWorkingDirectories` 时，Claude Code 不读写由仓库提供的设置所选的 auto memory 目录。{[M3]}{[M4]}

目录中的 `MEMORY.md` 是索引，每条记忆可放一行链接，指向存有细节的 Markdown 主题文件（例如 `feedback_testing.md`）。Claude Code 在会话启动时载入索引开头的 **200 行或 25 KB，以先达到的上限为准**；Claude 用常规文件工具按需读取主题。Claude 写完索引后，客户端检查大小：接近限额时提示缩减，超过限额时写入仍然成功，但工具会提示重写索引，超出的内容下次启动时不会自动载入。25 KB 的上限自 v2.1.83 起与行数限制并用。{[M3]}{[M12]}

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

在 subagent 定义的 YAML frontmatter 中配置 `memory`，且会话的 auto memory 已启用时，Claude Code 才加载该 subagent 的持久记忆。它会将目录读写说明和 `MEMORY.md` 的前 200 行或 25 KB 加入该 subagent 的 system prompt，并为维护记忆启用 Read、Write 和 Edit。{[M5]}

| `memory` 的作用域 | 目录 | 适用场景 |
| --- | --- | --- |
| `user` | `~/.claude/agent-memory/<agent-name>/` | 同一 subagent 在用户的不同项目中积累经验。{[M5]} |
| `project` | `.claude/agent-memory/<agent-name>/` | 记忆限于项目，可通过版本控制共享。{[M5]} |
| `local` | `.claude/agent-memory-local/<agent-name>/` | 记忆限于项目，适合放在版本控制之外的个人笔记。{[M5]} |

同一 subagent 的新调用可以复用上述目录。要延续它的某次工作，则恢复原有 subagent 的会话；它的 transcript 存在父会话的 `~/.claude/projects/<project>/<session-id>/subagents/agent-<agent-id>.jsonl`，主对话压缩时不改写该记录。{[M5]}{[M9]}

## 会话记录、恢复和 context compaction

### 本地记录和恢复

默认的 transcript 是明文 JSONL，路径为 `~/.claude/projects/<project>/<session-id>.jsonl`。这里的 `<project>` 默认由启动的工作目录路径生成（非字母数字字符替换为 `-`）；因此会话的目录键与 auto memory 按仓库共享的键应分开理解。`claude --continue` 继续当前目录最近的适用会话；`claude --resume <session-id>`、`claude --resume <绝对 transcript 路径>` 和会话内的 `/resume` 则选择指定会话。{[M3]}{[M8]}{[M9]}

恢复时，Claude Code 从记录重建先前的消息和工具交互，并沿用会话 ID。若该会话已经压缩，模型继续使用最近一次的摘要、该次压缩保留的未摘要消息，以及压缩以后的消息；压缩前已被摘要替代的消息不重新进入窗口。`/branch` 或 `--fork-session` 会将历史复制到新的会话 ID。{[M6]}{[M8]}

`cleanupPeriodDays` 通常默认 30 天，最小为 1 天；Claude Desktop 和 Cowork 有单独的会话保留规则。删除单个 transcript 会影响该会话的恢复；如需删除 auto memory，要处理对应的记忆文件。项目级 `claude purge` 的范围更大，可同时删除项目数据目录中的会话和 auto memory，执行前可用 `--dry-run` 查看范围。希望本次非交互运行不写 transcript 时，可使用 `-p --no-session-persistence`。{[M8]}{[M9]}

### 压缩后如何重建上下文

上下文接近模型和配置决定的上限时，Claude Code 会自动摘要对话；也可使用 `/compact [instructions]`，或在 `CLAUDE.md` 里加入 `Compact Instructions` 指定要保留的工作信息。摘要通常保留任务目标、进度和关键代码片段，早期消息中的细节可能只剩概述。`/clear` 则开始新对话并重新载入启动上下文；默认保存的旧会话仍可用 `/resume` 恢复。{[M6]}{[M7]}{[M8]}{[M10]}{[M11]}

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

按 Piebald 的提示词快照，示例中的 `feedback_api_tests.md` 可以采用以下格式，`MEMORY.md` 中对应的一行可以写作 `- [API 集成测试使用本地 Redis](feedback_api_tests.md)`。{[M3]}{[M13]}

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
| 是否有 auto memory 提取流程？ | Claude Code v2.1.323 的发布记录称，在 Anthropic 托管的云端会话中，`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` 不再作用于 auto memory extraction（记忆提取），主会话仍按该变量工作。记录确认该环境有单独的提取路径，未说明每个模型或会话的触发时机。{[M12]} |
| 是否有 Claude Code 的 memory consolidation、`autoDream` 或 `/dream`？ | 截至核对的 v2.1.327 发布记录，Claude Code 的公开 memory、命令和设置文档未给出这些功能的公开启用方式、默认值或调度规则。索引接近上限时提示 Claude 整理，属于文档确认的行为；静态 Dream 模板另见下文。{[M3]}{[M4]}{[M12]}{[M13]} |
| 是否有 remote memory？ | v2.1.172 的发布记录修复了远程会话访问已挂载的团队记忆库（`CLAUDE_MEMORY_STORES`）时的召回问题；v2.1.69 也提到过 memory sync 的文件处理优化。公开资料未给出普通 CLI 用户的启用条件、同步范围和冲突处理方式。本地仓库的 auto memory 仍按官方文档所述保存在本机。Remote Control 连接同一个本地运行的会话，云端新会话则在另一套环境运行。{[M3]}{[M12]}{[M14]} |

### Piebald-AI 的 v2.1.326 静态快照

下列内容来自 Piebald-AI 的 `v2.1.326` 标签。快照包含不同版本开始收录或更新的提示词片段，以及由运行时填写的变量。它们描述选中该提示词路径时的指令，具体的路由条件与触发频率仍需按客户端版本和会话核实。{[M13]}

- **分类和文件组织。** `Memory instructions` 要求每个文件保存一条事实，以 `name` 和 `description` 供召回时判断相关性。模板列出 `user`、`feedback`、`project` 和 `reference`；对反馈与项目类条目，要求写明原因及适用方式。{[M13]}
- **何时收集。** `memory_write update triggers and timing` 在采用该工具提示词时，要求在处理持久纠正、持续偏好或可复用的环境变化的同一回复中写入，排除只对当前任务适用的要求和短暂状态。另一个 `Memory extraction recent context only` 提醒提取子代理只考虑最近的若干消息，消息数量在模板中是变量。{[M13]}
- **召回与整理。** 快照中的记忆选择器要求根据文件名和描述选出明确有用的文件，最多返回 5 个，也可以返回空列表。`Dream memory consolidation` 模板则要求先检查已有笔记，必要时定向查找 transcript，再合并重复内容、更新过时事实和整理索引。模板中存在团队记忆条件分支，部署情况仍以官方文档和发布记录为准。{[M13]}

## 与 API 和 prompt cache 的区别

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
- **[M12]** Anthropic，Claude Code 发布记录：[v2.1.59：auto memory 与 `/memory`](https://github.com/anthropics/claude-code/releases/tag/v2.1.59)、[v2.1.69：memory sync](https://github.com/anthropics/claude-code/releases/tag/v2.1.69)、[v2.1.83：索引的字节限制](https://github.com/anthropics/claude-code/releases/tag/v2.1.83)、[v2.1.172：远程会话的团队记忆库](https://github.com/anthropics/claude-code/releases/tag/v2.1.172)、[v2.1.323：云端记忆提取](https://github.com/anthropics/claude-code/releases/tag/v2.1.323)、[v2.1.327：本次核对的最近版本](https://github.com/anthropics/claude-code/releases/tag/v2.1.327)。
- **[M13]** Piebald-AI，`v2.1.326` 静态快照：[Memory instructions](https://raw.githubusercontent.com/Piebald-AI/claude-code-system-prompts/v2.1.326/system-prompts/system-prompt-memory-instructions.md)、[写入时机](https://raw.githubusercontent.com/Piebald-AI/claude-code-system-prompts/v2.1.326/system-prompts/tool-description-memory-write-update-triggers-and-timing.md)、[提取采用近段历史](https://raw.githubusercontent.com/Piebald-AI/claude-code-system-prompts/v2.1.326/system-prompts/system-reminder-memory-extraction-recent-context-only.md)、[召回选择器](https://raw.githubusercontent.com/Piebald-AI/claude-code-system-prompts/v2.1.326/system-prompts/agent-prompt-determine-which-memory-files-to-attach.md)、[Dream 整理模板](https://raw.githubusercontent.com/Piebald-AI/claude-code-system-prompts/v2.1.326/system-prompts/agent-prompt-dream-memory-consolidation.md)。
- **[M14]** Anthropic，[云端会话能读取哪些本地配置](https://code.claude.com/docs/en/cloud-environments#what-carries-over-from-your-setup)、[Remote Control 的本机运行方式](https://code.claude.com/docs/en/remote-control)、[自托管环境的配置](https://code.claude.com/docs/en/self-hosted-environments-configuration#how-each-sessions-config-is-assembled)。
- **[M15]** Anthropic，Messages API：[Memory tool 的客户端读写](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool#how-it-works)、[启用工具](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool#getting-started)、[与 API compaction 配合使用](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool#using-with-compaction)。
- **[M16]** Anthropic，Claude Managed Agents：[Using agent memory](https://platform.claude.com/docs/en/managed-agents/memory)、[Dreams 的输入与输出](https://platform.claude.com/docs/en/managed-agents/dreams#how-it-works)、[开放状态](https://platform.claude.com/docs/en/managed-agents/dreams#availability)。
