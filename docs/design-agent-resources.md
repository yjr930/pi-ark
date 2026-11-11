# Agent 资源联合设计：Skills 与 MCP（计划）

状态：计划，尚未实现。

本文档合并两项设计：Skills 管理（Global 与 Workspace 两级）和浏览器能力接入（MCP server `playwright`）。两者在 pi-ark 里属于同一类 Agent 资源，共用发现、启用、诊断与生效流程。

## 1. 设计目标

- 系统自带一批 skill，与用户 skill 分开存放、分开展示、分别控制启用。
- 用户在 Global 与 Workspace 两个作用域管理自己的 skill。
- 浏览器能力通过 MCP server 提供，内置一份 `playwright` server 配置，由用户控制启用。
- 系统自带 skill 与 MCP server 的启用状态可在 Settings 页面修改，修改后对后续 Session 生效。
- 识别 pi 的其他 skill 来源，并支持把可用 skill 迁入 pi-ark 管理目录。

## 2. 资源模型

### 2.1 两类资源

| 资源 | 提供的内容 | 生效方式 |
|---|---|---|
| Skill | 操作流程与领域说明 | 名称与描述进入 system prompt，正文按需读取 |
| MCP server | 可执行工具 | 工具注册到 Session，按 exposure 决定模型可见性 |

### 2.2 三类来源

| 来源 | 作用域 | 存放位置 | 可编辑 | 启用控制 |
|---|---|---|---|---|
| Built-in | Global | 安装根目录 `skills/` | 否 | 是 |
| User | Global | `PI_ARK_AGENT_DIR/skills/` | 是 | 是 |
| User | Workspace | `<workspace>/.pi-ark/skills/` | 是 | 是 |
| External | Global | `~/.agents/skills/`、`PI_ARK_AGENT_DIR/settings.json` 的 `skills`、Pi package | 否 | 是 |
| External | Workspace | `<workspace>/.pi/skills/`、`<workspace>/.agents/skills/`、祖先目录的 `.agents/skills/` | 否 | 否，仅可迁移 |

Built-in 与 User 来源由 pi-ark 管理，External 来源由 pi 或用户其他工具管理。

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
      "disabledWorkspace": { "<workspace-id>": ["release-check"] },
      "migrations": [
        {
          "name": "pdf-tools",
          "from": "/root/workspace/trade_engine/.pi/skills/pdf-tools",
          "to": "/root/workspace/trade_engine/.pi-ark/skills/pdf-tools",
          "migratedAt": "2026-02-11T09:30:00.000Z"
        }
      ]
    }
  }
}
```

- 停用清单按 skill 名称记录，加载后名称在集合内不重复。
- Built-in 的停用记录独立保存，用户停用过的内置 skill 在升级后保持停用。
- 停用清单保存时按当前扫描结果归一化，丢弃已不存在的名称。
- 启用状态按 Workspace ID 存储，Workspace 移除后停用记录保留，重新注册同名 Workspace 时行为可预期。

## 5. 服务端模块

| 模块 | 职责 |
|---|---|
| `ResourceRegistry` | 汇总发现结果、合并同名项、应用启停过滤、收集诊断 |
| `SkillService` | 扫描 Built-in、Global、Workspace 与 External 来源，提供列表与迁移 |
| `McpService` | 生成与读写 `mcp.json`，管理内置 `playwright` server，报告连接状态 |
| `createResourceLoader()` | 由 `AgentService` 抽出，供 Session、预览与 Settings 共用 |

- `ResourceRegistry` 的行字段统一为 `name`、`kind`、`scope`、`source`、`enabled`、`location`、`diagnostics`。
- Skill 的 `location` 是目录，MCP server 的 `location` 是启动命令或 URL。
- `SkillService` 使用 `skillsOverride` 回调同时保存完整列表与实际生效列表。
- `SkillService` 用 `loadSkillsFromDir()` 扫描 External 来源，结果只进入列表。

## 6. 加载与生效

- Built-in 目录通过 `additionalSkillPaths` 传给 `DefaultResourceLoader`，目录存在时才传。
- Global 与 Workspace 目录由 loader 自动扫描，Workspace 目录通过 `additionalSkillPaths` 传入。
- `skillsOverride` 过滤停用项，并把未过滤的完整列表交给 `SkillService`。
- MCP 通过 `createMcpExtension` 挂载，`codemode` 通过 `createCodemodeExtension` 挂载。
- MCP server 使用 `codemode` 暴露时，MCP extension 在连接后把 `codemode` 加入活动工具。
- MCP server 的连接在 `session_start` 建立，在 `session_shutdown` 关闭。
- 启停修改后，Server 重建 loader，并对空闲 Session 调用 `session.reload()`。
- 运行中的 Session 延后生效，界面提示下次启动生效。
- 新 Session 与 subagent 直接使用最新集合。
- Global system prompt 预览使用与目标 Workspace 相同的停用集合，保证预览与运行时一致。

## 7. 内置 skill

### 7.1 首批清单

| Skill | 用途 | 依赖 |
|---|---|---|
| `browser` | 用 MCP `playwright` server 打开网页、点击、输入、截图 | `playwright` MCP server 已启用且浏览器运行时已安装 |

后续内置 skill 按需要增加，新增时同时更新本表与 `docs/index.md`。

### 7.2 browser skill 的内容要点

- 打开页面后先取页面快照，再按快照里的元素引用执行点击或输入。
- 脚本用 `describeNamespace("playwright")` 或 `searchTools()` 找到 `mcp__playwright__*` 工具，再通过 `tools.<name>(args)` 调用。
- 一次脚本完成打开页面、取快照、定位元素、点击与截图，减少模型往返。
- 文本结果用 `text()` 输出，截图用 `image()` 输出图片。
- 需要保存页面证据时使用整页截图，需要表达当前屏幕时使用视口截图。
- 页面依赖异步加载时，用 `browser_wait_for` 等待目标元素出现再继续。
- 脚本失败时保留部分输出，按 `Script error` 调整参数后重试。
- 工具不可用时，先确认 `playwright` server 已启用、浏览器运行时已安装。

## 8. MCP 接入：浏览器能力

### 8.1 内置 server 定义

`PI_ARK_AGENT_DIR/mcp.json` 由 pi-ark 初始化为以下内容，`enabled` 与 `exposure` 由 Settings 页面修改。

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

### 8.2 工具暴露

`@playwright/mcp` 0.0.85 提供 61 个 `browser_*` 工具。首版决定整个 `playwright` server 使用 `codemode` 暴露：

- 61 个工具不进入请求声明，请求里只有 `codemode` 一个工具。
- 模型按 browser skill 的指导写脚本，通过 `tools.mcp__playwright__browser_*` 调用工具。
- `direct` 与 `toolExposure` 方案作为备选，首版不采用。

### 8.3 浏览器运行时

- 浏览器二进制不进入 pi-ark 发布包，默认安装到 `~/.cache/ms-playwright`。
- 首次启用 `playwright` server 时，Server 检查缓存目录，缺失时提示安装命令。
- 安装命令为 `npx playwright install chromium --only-shell`，只装无头版本。
- 安装需要网络与磁盘写入，由用户确认后执行。

### 8.4 截图与结果

- `browser_take_screenshot` 不带 `filename` 时把图片作为 image result 返回，并把文件写入输出目录。
- `browser_take_screenshot` 带 `filename` 时把图片保存到指定文件，返回文件结果。
- codemode 脚本用 `image()` 把截图输出给模型。
- pi-ark 的 Web 端已经能渲染 tool result 中的图片，点击可以放大。
- 页面正文与快照文本按现有 tool result 展示，长文本保留折叠。

## 9. Settings 页面

### 9.1 Skills

页面分三段，顺序固定：

1. Built-in skills：复选框、名称、描述、状态、查看正文。
2. Global skills：复选框、名称、描述、来源标记、路径、查看正文。
3. Workspace skills：顶部 Workspace 选择器，默认当前 Workspace，行结构与 Global 相同。

来源标记取 `Built-in`、`Managed`、`External`、`Not loaded`，状态取 `Enabled`、`Disabled`、`Explicit only`、`Migrated`。

- Built-in 行只提供启用与查看，没有编辑与删除。
- `Not loaded` 行不出现复选框，只提供 Migrate。
- 页面顶部显示启用 skill 的 description 常驻长度与估算 token。
- 正文预览由服务端读取，复用现有 Markdown 组件。
- 创建与编辑通过 Terminal 完成，页面给出目录路径。

### 9.2 MCP

页面分两段：

1. Built-in servers：`playwright` 的启用开关、exposure 选择、浏览器运行时状态、安装按钮。
2. User servers：名称、命令或 URL、启用开关、连接状态、工具数量、诊断。

- 连接状态取 `Starting`、`Connected`、`Needs sign-in`、`Failed`、`Disabled`。
- `playwright` 未启用时，Skills 页面的 `browser` 行显示依赖未满足。
- 工具暴露变更后提示需要重新加载 Session。

## 10. API

| 方法与路径 | 作用 |
|---|---|
| `GET /api/skills?workspaceId=` | 返回 Built-in、Global、Workspace 三段列表、来源、状态与诊断 |
| `PUT /api/skills/selection` | 保存 `disabledBuiltin`、`disabledGlobal` 与 `disabledWorkspace` |
| `POST /api/skills/migrate` | 复制 External 来源到目标作用域并写入迁移记录 |
| `POST /api/skills/reload` | 重建 loader 并重新加载空闲 Session |
| `GET /api/mcp?workspaceId=` | 返回 Built-in 与 User server、状态、工具数量与诊断 |
| `PUT /api/mcp/servers` | 保存 server 的启用状态与 exposure |
| `POST /api/mcp/install-browser` | 执行浏览器运行时安装并返回结果 |

## 11. 诊断与升级

- `mcp.json` 解析失败、server 连接失败、浏览器缺失时，诊断进入 Settings 页面与 Session 状态提示。
- `codemode` 未启用而 server 使用 `codemode` exposure 时，界面提示工具不可达。
- Skill 名称冲突保留先发现的项，冲突项进入诊断。
- 同名冲突下停用只作用于胜出的项。
- 内置 skill 升级时整体替换 `skills/`，用户停用记录保留。
- 内置 MCP server 升级时更新 `mcp.json` 的固定版本，用户启用状态保留。

## 12. 实施顺序

1. 抽取 `createResourceLoader()`，加入 `additionalSkillPaths` 与 `skillsOverride` 支持。
2. 增加 `SkillService` 与 Skills 页面，覆盖 Built-in、Global、Workspace 三段。
3. 增加 External 来源扫描与迁移流程。
4. 挂载 `createMcpExtension` 与 `createCodemodeExtension`，初始化 `mcp.json`。
5. 增加 MCP 页面、浏览器运行时检查与安装入口。
6. 加入 `browser` 内置 skill，与 MCP 页面联动显示依赖状态。
7. 更新 `docs/product-and-interaction.md`、`docs/architecture.md`、`docs/user-guide.md` 与 `docs/index.md`。

## 13. 待定问题

- 浏览器运行时安装是否由 Server 自动执行，还是只提供命令与状态。
- Built-in skill 的清单除 `browser` 外还有哪些。
- User MCP server 的添加与编辑是否在首版提供。
