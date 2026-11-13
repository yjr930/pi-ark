---
name: mcp-servers
description: 为 Pi-Ark 接入、验证和维护 MCP server（搜索、文档、内部系统）。适用于用户要求增加新的外部工具能力、配置 API 密钥或排查 MCP 连接失败。
---

# MCP server 接入

## 前置条件

- server 定义保存在环境变量 `PI_ARK_AGENT_DIR` 指向目录下的 `mcp.json`，同一文件保存 `enabled`、`exposure`、`toolExposure` 与 `timeout`。
- 工作区里已有 `.pi/mcp.json` 时，Pi-Ark 也会读取它，其中的 server 在 Settings 里标记为 Project，开关写回该文件。新增 server 写入 `PI_ARK_AGENT_DIR/mcp.json`，除非用户要求项目级配置。
- 命令行入口是 `$PI_ARK_CLI_NAME mcp`，其中 `PI_ARK_CLI_NAME` 是当前实例的 CLI 名称，`pi-ark-dev` 是主力开发实例的名称。
- server 连接在 Session 启动时建立。修改配置后新 Session 才使用新配置，当前 Session 的可用工具保持不变。
- 传输只支持 stdio 与 streamable HTTP。SSE 端点会被拒绝，很多服务另外提供 `/mcp` 路径的 streamable HTTP。

## 添加 server

优先用命令行添加，需要写 `exposure` 或 `toolExposure` 时再直接编辑 `mcp.json`。

```bash
$PI_ARK_CLI_NAME mcp add <name> --url https://example.com/mcp
$PI_ARK_CLI_NAME mcp add <name> -- <command> [args...]
$PI_ARK_CLI_NAME mcp add <name> --env KEY=VALUE -- npx -y <package>
```

- server 名只允许字母、数字、`_` 与 `-`。只差 `-` 与 `_` 的两个名字算同一个 server，第二个会被拒绝。
- 工具标识符是 `mcp__<server>__<tool>`。
- 搜索类 server 的工具多、返回内容长，保持 `exposure` 为 `codemode`，在脚本里调用并裁剪结果。
- 需要让模型直接看到某个工具时，用 `toolExposure` 把该工具设为 `direct`，不要整体改成 `direct`。
- 给每个 server 写一句 `description`。它进入系统提示词，并决定 `searchTools()` 的排序，多个同类 server 并存时靠它区分用途。

## 密钥

三条通道，按推荐顺序使用。

1. 文件加取值命令：`"headers": { "Authorization": "!echo Bearer $(cat $PI_ARK_AGENT_DIR/secrets/<name>)" }`。取值命令必须是整个值，支持 shell 语法，在连接时执行。
2. 明文写进 `mcp.json` 的 `env` 或 `headers`。文件权限是 0600，`mcp list --json` 不打印值。
3. `${VAR}` 引用服务进程的环境变量。unit 的 `Environment=` 行由安装器重新生成，修改后需要重启服务。

密钥目录是 `$PI_ARK_AGENT_DIR/secrets`，安装器创建，权限 0700。密钥文件用 0600。

## 用户自己保管密钥

用户不愿意把密钥交给 AI 时按以下顺序处理。

1. AI 写好 `mcp.json`，密钥位置指向 `$PI_ARK_AGENT_DIR/secrets/<name>`。
2. 让用户在该目录下创建文件并写入密钥，再执行 `chmod 600 <file>`。
3. 用户在网页的 Terminal 或自己的 SSH 会话里完成，密钥内容不进入对话。
4. 用户新开一个 Session 后生效。

## 验证

```bash
$PI_ARK_CLI_NAME mcp list
$PI_ARK_CLI_NAME mcp list --json
```

- 每个 server 有 `state`、`tools` 与 `errors`，`connected` 表示连接成功。
- `list --json` 的 `transport` 只显示命令或 URL，不含密钥值。
- Settings → MCP 点一次 Refresh 也能看到连接状态、工具数量与诊断。
- 需要 OAuth 的服务用 `$PI_ARK_CLI_NAME mcp login <name>`，页面会给出同样的命令提示。

## 排查

- `Needs sign-in`：执行 `$PI_ARK_CLI_NAME mcp login <name>`。
- `Failed`：先看 `mcp list` 输出的错误行，再看 `$PI_ARK_AGENT_DIR/mcp.log` 的尾部。
- stdio server 起不来：确认 `command` 是单个可执行文件，参数写在 `args` 里。
- 工具没有出现：确认 `enabled` 为 true，并已打开新的 Session。
