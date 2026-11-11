# Agent 资源联合设计：Skills 与 MCP

状态：已实现。页面行为见[功能与交互设计](product-and-interaction.md)，模块与数据流见[程序实现架构](architecture.md)，操作步骤见[使用手册](user-guide.md)。

本文档合并两项设计：Skills 管理（Global 与 Workspace 两级）和浏览器能力接入（MCP server `playwright`）。两者在 pi-ark 里属于同一类 Agent 资源，共用发现、启用、诊断与生效流程。

## 实现入口

| 入口 | 文件 | 职责 |
|---|---|---|
| 资源加载 | `apps/server/src/resource-loader.ts` | 定义三个 skill 目录，创建带 `additionalSkillPaths` 与 `skillsOverride` 的 loader，并挂载 MCP 与 codemode extension |
| Skill 服务 | `apps/server/src/skills.ts` | 扫描三段 skill、处理同名冲突、应用停用清单、保存选择并重新加载空闲 Session |
| MCP 服务 | `apps/server/src/mcp.ts` | 初始化 `mcp.json`、读取 `pi mcp list --json`、保存启用状态、检查并安装浏览器运行时 |
| 配置 | `apps/server/src/config.ts` | 读取、归一化和保存 `preferences.skills` |
| HTTP API | `apps/server/src/index.ts` | Skills 与 MCP 的读取、保存、刷新和浏览器安装端点 |
| Skills 页面 | `apps/web/src/components/SkillsSettings.tsx` | 三段 skill 列表、Workspace 选择器、启用复选框和 Refresh |
| MCP 页面 | `apps/web/src/components/McpSettings.tsx` | server 列表、启用开关、连接状态、诊断和浏览器运行时 |
| 命令行 | `scripts/pi-ark.mjs` | `pi-ark mcp` 子命令，透传 pi core 的 `mcp` 命令 |
| 发布 | `scripts/build-release.mjs` | 把源码根目录的 `skills/` 复制到安装包 |

## 1. 设计目标

- 系统自带一批 skill，与用户 skill 分开存放、分开展示、分别控制启用。
- 用户在 Global 与 Workspace 两个作用域管理自己的 skill。
- 浏览器能力通过 MCP server 提供，内置一份 `playwright` server 配置，由用户控制启用。
- 系统自带 skill 与 MCP server 的启用状态可在 Settings 页面修改，修改后对空闲 Session 生效，新建 Session 使用最新状态。
- 通用 MCP server 通过 `pi-ark mcp` 命令与 `mcp.json` 管理，Settings 页面只展示列表与启用开关。

## 2. 资源模型

### 2.1 两类资源

| 资源 | 提供的内容 | 生效方式 |
|---|---|---|
| Skill | 操作流程与领域说明 | 名称与描述进入 system prompt，正文按需读取 |
| MCP server | 可执行工具 | 工具注册到 Session，按 exposure 决定模型可见性 |

### 2.2 两类来源

| 来源 | 作用域 | 存放位置 | 可编辑 | 启用控制 |
|---|---|---|---|---|
| Built-in | Global | 安装根目录 `skills/` | 否 | 是 |
| User | Global | `PI_ARK_AGENT_DIR/skills/` | 是 | 是 |
| User | Workspace | `<workspace>/.pi-ark/skills/` | 是 | 是 |

Built-in 与 User 来源由 pi-ark 管理。

### 2.3 MCP server 来源

| 来源 | 存放位置 | 管理方式 |
|---|---|---|
| Built-in | `PI_ARK_AGENT_DIR/mcp.json` 的 `playwright` 条目 | pi-ark 初始化，用户只改启用 |
| User | `PI_ARK_AGENT_DIR/mcp.json` 的其他条目 | 通过 `pi-ark mcp` 命令或直接编辑 `mcp.json` |

## 3. 目录与发布布局

```text
<install-root>/skills/<skill-name>/SKILL.md          # Built-in，随版本更新
$PI_ARK_AGENT_DIR/skills/<skill-name>/SKILL.md       # User Global
<workspace>/.pi-ark/skills/<skill-name>/SKILL.md     # User Workspace
```

- `scripts/build-release.mjs` 在打包时把源码根目录的 `skills/` 复制到安装包，并随安装进入安装根目录。
- 安装根目录由 `apps/server/src/resource-loader.ts` 从自身模块位置向上解析，与服务端自身位置一致。
- Built-in 目录由 release 管理，pi-ark 更新版本时整体替换，用户的启用与停用记录保存在 `config.json`。
- Workspace 的 `.pi-ark/skills` 按需创建，`ensureWorkspaceState()` 只负责 `sessions` 目录。

## 4. 启用状态与配置

启用状态写在 `PI_ARK_HOME/config.json` 的 `preferences.skills` 下。

```json
{
  "preferences": {
    "skills": {
      "disabledBuiltin": ["browser"],
      "disabledGlobal": ["pdf-tools"],
      "disabledWorkspace": { "<workspace-id>": ["release-check"] }
    }
  }
}
```

- 停用清单按 skill 名称记录，加载后名称在集合内不重复。
- Built-in 的停用记录独立保存，用户停用过的内置 skill 在升级后保持停用。
- 停用清单保存时按当前扫描结果归一化，丢弃已不存在的名称。
- 启用状态按 Workspace ID 存储，Workspace 移除后停用记录保留，重新注册同名 Workspace 时行为可预期。

MCP server 的定义与启用状态写在 `PI_ARK_AGENT_DIR/mcp.json`，pi core 的 MCP extension 直接读取该文件。`enabled`、`exposure`、`toolExposure`、`timeout` 与 server 定义保存在一起；Settings 页面只修改 `enabled`，其他字段由 `pi-ark mcp` 命令或直接编辑文件修改。

## 5. 服务端模块

| 模块 | 职责 |
|---|---|
| `resource-loader.ts` | 定义三个 skill 目录，创建带 `additionalSkillPaths` 与 `skillsOverride` 的 `DefaultResourceLoader`，并挂载 MCP 与 codemode extension |
| `skills.ts` | `SkillService` 扫描三段目录、处理同名冲突、应用停用清单、保存选择并重新加载空闲 Session |
| `mcp.ts` | `McpService` 初始化 `mcp.json`、读取 `pi mcp list --json`、保存启用状态、检查并安装浏览器运行时 |
| `config.ts` | `SkillSelection` 的归一化、校验、读取与原子保存 |
| `index.ts` | 创建 `SkillService` 与 `McpService`，注册 Skills 与 MCP 端点 |

- Skill 行字段为 `name`、`description`、`scope`、`source`、`location`、`enabled` 与 `explicitOnly`。
- Skill 的 `location` 是 skill 目录；MCP server 的启动命令或 URL 由列表结果的 `transport` 字段返回。
- `SkillService` 不单独保存完整列表；每次请求重新扫描目录，并与保存的停用清单合并。

## 6. 加载与生效

- Built-in、Global 与 Workspace 目录存在时都通过 `additionalSkillPaths` 传给 `DefaultResourceLoader`。
- `skillsOverride` 按 `skill.filePath` 判断来源，再根据对应作用域的停用清单过滤。
- MCP 通过 `createMcpExtension` 挂载，`codemode` 通过 `createCodemodeExtension` 挂载。
- `codemode` 注册为默认停用；Session 把 codemode 加入可用工具，再用初始活动工具集合将其排除。MCP extension 在 Session 启动时根据启用且 `exposure` 为 `codemode` 的 server 配置把 `codemode` 加入活动工具。
- MCP server 的连接在 `session_start` 建立，在 `session_shutdown` 关闭。
- Settings 的启用开关修改后，Server 保存配置并对空闲 Session 调用 `session.reload()`。
- 运行中的 Session 保持当前资源集合；新建 Session 与重启后打开的 Session 使用最新集合。
- Global system prompt 预览使用与目标 Workspace 相同的停用集合，保证预览与运行时一致。

## 7. 内置 skill

### 7.1 首批清单

| Skill | 用途 | 依赖 |
|---|---|---|
| `browser` | 用 MCP `playwright` server 打开网页、点击、输入、截图 | `playwright` MCP server 已启用且浏览器运行时已安装 |

首版只内置 `browser`。后续新增内置 skill 时同时更新本表与 `docs/index.md`。

### 7.2 browser skill 的内容要点

- 打开页面后先取页面快照，再按快照里的元素引用执行点击或输入。
- 脚本用 `describeNamespace("playwright")` 或 `searchTools()` 找到 `mcp__playwright__*` 工具，再通过 `tools.<name>(args)` 调用。
- 一次脚本完成打开页面、取快照、定位元素、点击与截图，减少模型往返。
- 文本结果用 `text()` 输出，截图用 `image()` 输出图片。
- 需要保存页面证据时使用整页截图，需要表达当前屏幕时使用视口截图。
- 页面依赖异步加载时，用 `browser_wait_for` 等待目标元素出现再继续。
- 脚本失败时保留部分输出，按 `Script error` 调整参数后重试。
- 工具不可用时，先确认 `playwright` server 已启用、浏览器运行时已安装。

## 8. MCP 接入

### 8.1 配置模型

`PI_ARK_AGENT_DIR/mcp.json` 是 MCP server 的唯一配置文件。

- stdio server 使用 `command`、`args`、`env`、`cwd`。
- HTTP server 使用 `url`、`headers`、`oauth`。
- 两类 server 都支持 `timeout`、`enabled`、`exposure`、`toolExposure` 与 `description`。
- `env` 与 `headers` 的值支持 `${VAR}` 引用环境变量，也支持 `!command` 形式的取值命令。
- server 名称只允许字母、数字、`_` 与 `-`。
- SSE 传输不受支持。

### 8.2 命令行与配置文件

- pi-ark 提供 `pi-ark mcp` 子命令，透传 pi core 的 `mcp` 命令，并设置 `PI_CODING_AGENT_DIR` 指向 `PI_ARK_AGENT_DIR`。
- `pi-ark mcp list --json` 输出每个 server 的 `name`、`scope`、`source`、`enabled`、`exposure`、`transport`、`state`、`tools` 与 `errors`；界面列表使用其中的名称、启用状态、exposure、transport、连接状态、工具与错误信息，`playwright` 的来源标记为 Built-in。
- `pi-ark mcp add <name>` 写 `mcp.json`，stdio 用 `--env` 与 `--` 后的命令定义，HTTP 用 `--url`、`--header`、`--bearer-token-env-var`。
- `pi-ark mcp remove <name>` 删除配置，已保存的 OAuth 凭据保留。
- `pi-ark mcp login <name>` 与 `pi-ark mcp logout <name>` 处理 OAuth 登录与退出。
- 密钥通过 `--env`、`--header` 与 `--bearer-token-env-var` 引用环境变量，pi-ark 不提供单独的密钥存储。
- 用户可以直接编辑 `PI_ARK_AGENT_DIR/mcp.json`，格式与 pi 的 `mcp.json` 一致。
- 配置变化后，Settings 页面通过 `Refresh` 按钮重新执行 `pi-ark mcp list --json` 并更新列表。
- 新 Session 启动时读取最新配置，运行中的 Session 需要重建后使用新配置。

### 8.3 内置 server 定义

`PI_ARK_AGENT_DIR/mcp.json` 由 pi-ark 初始化为以下内容。`enabled` 由 Settings 页面的开关修改，`exposure` 由 `pi-ark mcp` 命令或配置文件修改。

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp@0.0.85", "--caps=config,network,storage,devtools,vision"],
      "enabled": false,
      "exposure": "codemode",
      "description": "Browser automation for web pages"
    }
  }
}
```

- 当前版本固定为 `0.0.85`；首次启动且 `mcp.json` 不存在时写入该版本，已有的 `mcp.json` 保留原内容。
- 默认 `enabled: false`，用户首次启用时进入浏览器运行时检查。
- `exposure` 默认 `codemode`，模型通过脚本调用工具，工具声明不常驻请求。

### 8.4 工具暴露

`@playwright/mcp` 0.0.85 的 README 列出 61 个 `browser_*` 工具，默认连接暴露 25 个核心工具（包括 `browser_navigate`、`browser_snapshot`、`browser_click`、`browser_type`、`browser_take_screenshot`、`browser_wait_for`）。首版决定整个 `playwright` server 使用 `codemode` 暴露：

- 连接后暴露的工具不进入请求声明，MCP 相关声明只有 `codemode` 一个工具。
- 模型按 browser skill 的指导写脚本，通过 `tools.mcp__playwright__browser_*` 调用工具。
- `direct` 与 `toolExposure` 方案作为备选，首版不采用。

### 8.5 浏览器运行时

- 浏览器二进制不进入 pi-ark 发布包，安装到服务用户 home 下的 `.cache/ms-playwright`。
- 用户在 Settings 启用 `playwright` server 时，Server 检查缓存目录中是否存在 Chromium 目录。
- 缺失时 Server 自动执行 `npx @playwright/mcp@0.0.85 install-browser chromium --only-shell`。
- 安装任务在 Server 内串行执行，同一时间只允许一个任务。
- 安装状态取 `Not installed`、`Installing`、`Installed`、`Failed`。
- 安装失败时保留日志，server 保持停用；再次打开启用开关可以重试。
- Settings 页面在 Browser runtime 区域展示目标目录、状态与失败日志。

### 8.6 截图与结果

- `browser_take_screenshot` 不带 `filename` 时把图片作为 image result 返回，并把文件写入输出目录。
- `browser_take_screenshot` 带 `filename` 时把图片保存到指定文件，返回文件结果。
- codemode 脚本用 `image()` 把截图输出给模型。
- pi-ark 的 Web 端已经能渲染 tool result 中的图片，点击可以放大。
- 页面正文与快照文本按现有 tool result 展示，长文本保留折叠。

### 8.7 安装流程中的推荐步骤

- 安装流程不自动启用浏览器能力。
- Settings 的 MCP 页面在 `playwright` 行显示 `Recommended` 标记和 Browser runtime 区域。
- 推荐步骤不阻塞其他功能，用户可以从 MCP 页面随时进入。
- `playwright` 未启用时，Skills 页面的 `browser` 行显示 `Requires playwright`。

## 9. Settings 页面

### 9.1 Skills

页面分三段，顺序固定：

1. Built-in skills：复选框、名称、描述、状态、目录与 View。
2. Global skills：复选框、名称、描述、来源标记、目录与 View。
3. Workspace skills：顶部 Workspace 选择器，默认使用 URL 指定的 Workspace，没有指定时使用第一个 Workspace，行结构与 Global 相同。

来源标记取 `Built-in` 与 `Managed`，状态取 `Enabled`、`Disabled` 与 `Explicit only`。

- Built-in 行同样提供启用与 View，没有编辑与删除。
- 页面顶部显示启用 skill 数量、模型可见 description 的总字符数与估算 token。
- View 展开 Source、Scope、Mode 与 Location，并提示在 Terminal 打开该目录下的 `SKILL.md` 阅读正文。
- 创建与编辑通过 Terminal 完成，页面给出目录路径。
- Diagnostics 区域列出扫描错误与同名冲突。

### 9.2 MCP

页面只有一个列表，覆盖内置与用户 server：

- 每行包含名称、来源、transport、exposure、启用开关、连接状态、注册动作数量与诊断。`playwright` 行额外显示 Advanced capabilities 开关，默认开启，在 server 启用后可操作。
- `playwright` 行带 `Recommended` 标记与 Browser runtime 区域。
- 页面不提供添加、编辑、删除与 OAuth 登录按钮，这些操作通过 `pi-ark mcp` 命令完成。
- 需要登录的行显示 `Needs sign-in` 与命令 `pi-ark mcp login <server>`。
- 浏览器未安装或上次安装失败时，打开启用开关触发自动安装，行内显示安装状态、目标目录与失败日志。
- 连接状态取 `Starting`、`Connected`、`Needs sign-in`、`Failed`、`Disabled`。
- 页面提供 `Refresh` 按钮，重新执行 `pi-ark mcp list --json` 更新列表与状态。
- 页面首次进入 MCP 类别时读取一次，停留在该类别期间不自动刷新。
- 列表为空时显示 `pi-ark mcp add <name>` 提示。
- `playwright` 未启用时，Skills 页面的 `browser` 行显示 `Requires playwright`。

## 10. API

| 方法与路径 | 作用 |
|---|---|
| `GET /api/skills?workspaceId=` | 返回 Built-in、Global、Workspace 三段列表、来源、状态与诊断 |
| `PUT /api/skills/selection` | 保存 `disabledBuiltin`、`disabledGlobal` 与 `disabledWorkspace` |
| `POST /api/skills/reload` | 重建 loader 并重新加载空闲 Session |
| `GET /api/mcp?workspaceId=` | 返回 server 列表、状态、工具数量与诊断 |
| `PUT /api/mcp/servers/:name/state` | 保存启用状态 |
| `PUT /api/mcp/servers/:name/advanced` | 保存 playwright 的高级 capability 开关 |
| `GET /api/mcp/browser` | 返回浏览器安装状态、版本、目录与安装日志 |
| `POST /api/mcp/install-browser` | 启动浏览器运行时安装并返回当前状态 |

## 11. 诊断与升级

- `mcp.json` 解析失败、server 连接失败与浏览器安装失败时，诊断进入 Settings 页面。
- `pi-ark mcp list --json` 返回的 `errors` 与每个 server 的 `error` 进入列表诊断。
- 需要 OAuth 登录时，行内显示 `pi-ark mcp login <server>` 命令提示。
- 配置文件变化后，Settings 页面通过 `Refresh` 重新读取列表；新 Session 使用最新配置。
- Skill 名称冲突保留先发现的项，冲突项进入诊断。
- 同名冲突下停用只作用于胜出的项。
- 内置 skill 升级时整体替换 `skills/`，用户停用记录保留。
- `mcp.json` 已存在时 Server 保留原内容，内置 server 的版本与启用状态由该文件保存。

## 12. 实施顺序（已完成）

1. 抽取 `createResourceLoader()`，加入 `additionalSkillPaths` 与 `skillsOverride` 支持。
2. 增加 `SkillService` 与 Skills 页面，覆盖 Built-in、Global、Workspace 三段。
3. 挂载 `createMcpExtension` 与 `createCodemodeExtension`，初始化 `mcp.json`。
4. 增加 MCP 列表与启用开关、`pi-ark mcp` 命令透传、手动刷新、浏览器自动安装与推荐标记。
5. 加入 `browser` 内置 skill，与 MCP 页面联动显示依赖状态。
6. 更新 `docs/product-and-interaction.md`、`docs/architecture.md`、`docs/user-guide.md` 与 `docs/index.md`。

