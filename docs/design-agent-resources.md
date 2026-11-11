# Agent 资源联合设计：Skills 与 MCP（计划）

状态：计划，尚未实现。

本文档合并两项设计：Skills 管理（Global 与 Workspace 两级）和浏览器能力接入（MCP server `playwright`）。两者在 pi-ark 里属于同一类 Agent 资源，共用发现、启用、诊断与生效流程。

## 1. 设计目标

- 系统自带一批 skill，与用户 skill 分开存放、分开展示、分别控制启用。
- 用户在 Global 与 Workspace 两个作用域管理自己的 skill。
- 浏览器能力通过 MCP server 提供，内置一份 `playwright` server 配置，由用户控制启用。
- 系统自带 skill 与 MCP server 的启用状态可在 Settings 页面修改，修改后对后续 Session 生效。
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

- `scripts/build-release.mjs` 在打包时把源码根目录的 `skills/` 复制到安装根目录。
- 安装根目录通过 `apps/server/src/pi-core.ts` 的 `projectRoot` 定位，与服务端自身位置一致。
- Built-in 目录只读，pi-ark 更新版本时整体替换，用户的启用与停用记录保存在 `config.json`。
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

MCP server 的定义与启用状态写在 `PI_ARK_AGENT_DIR/mcp.json`，pi core 的 MCP extension 直接读取该文件。`enabled`、`exposure`、`toolExposure`、`timeout` 与 server 定义保存在一起，修改后由 `McpService` 写回该文件。

## 5. 服务端模块

| 模块 | 职责 |
|---|---|
| `ResourceRegistry` | 汇总发现结果、合并同名项、应用启停过滤、收集诊断 |
| `SkillService` | 扫描 Built-in、Global 与 Workspace 来源，提供列表 |
| `McpService` | 读取 `pi mcp list --json` 的结果，写启用状态，监听配置变化，重载空闲 Session |
| `createResourceLoader()` | 由 `AgentService` 抽出，供 Session、预览与 Settings 共用 |

- `ResourceRegistry` 的行字段统一为 `name`、`kind`、`scope`、`source`、`enabled`、`location`、`diagnostics`。
- Skill 的 `location` 是目录，MCP server 的 `location` 是启动命令或 URL。
- `SkillService` 使用 `skillsOverride` 回调同时保存完整列表与实际生效列表。

## 6. 加载与生效

- Built-in 目录通过 `additionalSkillPaths` 传给 `DefaultResourceLoader`，目录存在时才传。
- Global 与 Workspace 目录由 loader 自动扫描，Workspace 目录通过 `additionalSkillPaths` 传入。
- `skillsOverride` 过滤停用项，并把未过滤的完整列表交给 `SkillService`。
- MCP 通过 `createMcpExtension` 挂载，`codemode` 通过 `createCodemodeExtension` 挂载。
- MCP server 使用 `codemode` 暴露时，MCP extension 在连接后把 `codemode` 加入活动工具。
- MCP server 的连接在 `session_start` 建立，在 `session_shutdown` 关闭。
- Settings 的启用开关修改后，Server 重建 loader，并对空闲 Session 调用 `session.reload()`。
- 运行中的 Session 延后生效，界面提示下次启动生效。
- 新 Session 与 subagent 直接使用最新集合。
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
- `pi-ark mcp list --json` 输出每个 server 的 `name`、`scope`、`source`、`enabled`、`exposure`、`transport`、`state`、`tools` 与 `errors`，界面列表直接使用该结果。
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
      "args": ["@playwright/mcp@0.0.85"],
      "enabled": false,
      "exposure": "codemode",
      "description": "Browser automation for web pages"
    }
  }
}
```

- 版本固定为 `0.0.85`，随 pi-ark 版本升级更新。
- 默认 `enabled: false`，用户首次启用时进入浏览器运行时检查。
- `exposure` 默认 `codemode`，模型通过脚本调用工具，工具声明不常驻请求。

### 8.4 工具暴露

`@playwright/mcp` 0.0.85 提供 61 个 `browser_*` 工具。首版决定整个 `playwright` server 使用 `codemode` 暴露：

- 61 个工具不进入请求声明，请求里只有 `codemode` 一个工具。
- 模型按 browser skill 的指导写脚本，通过 `tools.mcp__playwright__browser_*` 调用工具。
- `direct` 与 `toolExposure` 方案作为备选，首版不采用。

### 8.5 浏览器运行时

- 浏览器二进制不进入 pi-ark 发布包，安装到服务用户的 `~/.cache/ms-playwright`。
- 用户在 Settings 启用 `playwright` server 时，Server 检查缓存目录与浏览器版本。
- 缺失或版本不匹配时，Server 自动执行 `npx @playwright/mcp@0.0.85 install-browser chromium --only-shell`。
- 安装任务在 Server 内串行执行，同一时间只允许一个任务。
- 安装状态取 `Not installed`、`Installing`、`Installed`、`Failed`，`Installing` 展示下载百分比或当前阶段。
- 安装失败时保留日志与重试按钮，server 保持停用。
- Settings 页面在开始前展示下载体积与目标目录。

### 8.6 截图与结果

- `browser_take_screenshot` 不带 `filename` 时把图片作为 image result 返回，并把文件写入输出目录。
- `browser_take_screenshot` 带 `filename` 时把图片保存到指定文件，返回文件结果。
- codemode 脚本用 `image()` 把截图输出给模型。
- pi-ark 的 Web 端已经能渲染 tool result 中的图片，点击可以放大。
- 页面正文与快照文本按现有 tool result 展示，长文本保留折叠。

### 8.7 安装流程中的推荐步骤

- 安装器完成后输出提示，引导用户到 Settings 启用浏览器能力。
- Web 首次登录后，Settings 的 MCP 页面显示推荐卡片：安装浏览器并启用 `playwright` server。
- 推荐步骤不阻塞其他功能，用户可以从 MCP 页面随时进入。
- 安装完成后，`browser` skill 的依赖状态变为满足。

## 9. Settings 页面

### 9.1 Skills

页面分三段，顺序固定：

1. Built-in skills：复选框、名称、描述、状态、查看正文。
2. Global skills：复选框、名称、描述、来源标记、路径、查看正文。
3. Workspace skills：顶部 Workspace 选择器，默认当前 Workspace，行结构与 Global 相同。

来源标记取 `Built-in` 与 `Managed`，状态取 `Enabled`、`Disabled` 与 `Explicit only`。

- Built-in 行只提供启用与查看，没有编辑与删除。
- 页面顶部显示启用 skill 的 description 常驻长度与估算 token。
- 正文预览由服务端读取，复用现有 Markdown 组件。
- 创建与编辑通过 Terminal 完成，页面给出目录路径。

### 9.2 MCP

页面只有一个列表，覆盖内置与用户 server：

- 每行包含名称、类型、transport、启用开关、连接状态、工具数量与诊断。
- `playwright` 行带推荐标记与浏览器运行时状态。
- exposure 以只读文本展示。
- 页面不提供添加、编辑、删除与 OAuth 登录按钮，这些操作通过 `pi-ark mcp` 命令完成。
- 需要登录的行显示 `Needs sign-in` 与命令 `pi-ark mcp login <server>`。
- 浏览器未安装时，打开启用开关触发自动安装，行内显示进度与结果。
- 连接状态取 `Starting`、`Connected`、`Needs sign-in`、`Failed`、`Disabled`。
- 页面提供 `Refresh` 按钮，重新执行 `pi-ark mcp list --json` 更新列表与状态。
- 页面打开时读取一次，后台不自动刷新。
- `playwright` 未启用时，Skills 页面的 `browser` 行显示依赖未满足。

## 10. API

| 方法与路径 | 作用 |
|---|---|
| `GET /api/skills?workspaceId=` | 返回 Built-in、Global、Workspace 三段列表、来源、状态与诊断 |
| `PUT /api/skills/selection` | 保存 `disabledBuiltin`、`disabledGlobal` 与 `disabledWorkspace` |
| `POST /api/skills/reload` | 重建 loader 并重新加载空闲 Session |
| `GET /api/mcp?workspaceId=` | 返回 server 列表、状态、工具数量与诊断 |
| `PUT /api/mcp/servers/:name/state` | 保存启用状态 |
| `GET /api/mcp/browser` | 返回浏览器安装状态、版本、目录与安装日志 |
| `POST /api/mcp/install-browser` | 启用 `playwright` 时触发的安装端点 |

## 11. 诊断与升级

- `mcp.json` 解析失败、server 连接失败、浏览器缺失时，诊断进入 Settings 页面与 Session 状态提示。
- `pi-ark mcp list --json` 返回的 `errors` 进入列表诊断。
- 需要 OAuth 登录时，行内显示 `pi-ark mcp login <server>` 命令提示。
- 配置文件变化后，Settings 页面通过 `Refresh` 重新读取列表；新 Session 使用最新配置。
- `codemode` 未启用而 server 使用 `codemode` exposure 时，界面提示工具不可达。
- Skill 名称冲突保留先发现的项，冲突项进入诊断。
- 同名冲突下停用只作用于胜出的项。
- 内置 skill 升级时整体替换 `skills/`，用户停用记录保留。
- 内置 MCP server 升级时更新 `mcp.json` 的固定版本，用户启用状态保留。

## 12. 实施顺序

1. 抽取 `createResourceLoader()`，加入 `additionalSkillPaths` 与 `skillsOverride` 支持。
2. 增加 `SkillService` 与 Skills 页面，覆盖 Built-in、Global、Workspace 三段。
3. 挂载 `createMcpExtension` 与 `createCodemodeExtension`，初始化 `mcp.json`。
4. 增加 MCP 列表与启用开关、`pi-ark mcp` 命令透传、手动刷新、浏览器自动安装与推荐卡片。
5. 加入 `browser` 内置 skill，与 MCP 页面联动显示依赖状态。
6. 更新 `docs/product-and-interaction.md`、`docs/architecture.md`、`docs/user-guide.md` 与 `docs/index.md`。

