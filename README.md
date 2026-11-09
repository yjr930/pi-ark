# Pi-Ark

Pi-Ark 是一个以工作区为单位管理 pi coding agent 的 Web UI。它作为全局 HTTPS 服务运行，并提供 Agent 对话、工作区文件浏览、Markdown 阅读和浏览器 Terminal。

## 当前能力

- 使用 `@earendil-works/pi-coding-agent` SDK，并显示流式 session 消息和工具调用。
- 从全局配置中选择工作区，每个 session 固定使用一个工作区目录。
- 将 pi session 保存在 `<workspace>/.pi-ark/sessions/`。
- 浏览工作区目录和文本文件，并以接近 Obsidian 的阅读样式渲染 Markdown。
- 通过 xterm.js 和 node-pty 提供工作区 Terminal。
- 提供适用于桌面与手机的响应式界面。
- 使用 HTTPS、`Secure` cookie 和本地单用户密码认证。

## 环境要求

- Node.js 22.19 或更新版本
- npm
- OpenSSL
- 可以正常使用的 pi 全局配置和模型凭证（默认位于 `~/.pi/agent`）
- node-pty 编译环境（Linux 通常需要 Python、make 和 C++ compiler）

## 安装

```bash
npm install
npm run setup -- --username ark --password 'choose-a-password' --workspace /absolute/path/to/workspace
npm run build
npm start
```

初始化命令会在 `~/.pi-ark/` 中创建全局配置和自签名 TLS 证书。浏览器首次访问 `https://127.0.0.1:31415` 时需要信任该本地证书。

可以使用以下参数调整初始化结果：

```bash
npm run setup -- \
  --username ark \
  --password 'choose-a-password' \
  --workspace /absolute/path/to/workspace \
  --id workspace-id \
  --name 'Workspace name' \
  --host 127.0.0.1 \
  --port 31415
```

`PI_ARK_HOME` 可以修改 Pi-Ark 的全局配置目录。生产部署可以在 `config.json` 中替换 `tls.keyPath` 和 `tls.certPath`，使用受信任的 TLS 证书。

## 开发

先执行初始化，然后运行：

```bash
npm run dev
```

Vite 开发服务位于 `http://localhost:5173`，并将 API 与 WebSocket 转发到本地 Pi-Ark HTTPS 服务。正式构建由 Pi-Ark 服务直接提供 Web UI。

## 全局配置

默认配置文件是 `~/.pi-ark/config.json`：

```json
{
  "listen": { "host": "127.0.0.1", "port": 31415 },
  "tls": {
    "keyPath": "/home/user/.pi-ark/tls/server.key",
    "certPath": "/home/user/.pi-ark/tls/server.crt"
  },
  "auth": {
    "username": "ark",
    "passwordHash": "scrypt$salt$digest"
  },
  "workspaces": [
    { "id": "project", "name": "Project", "path": "/absolute/path/to/project" }
  ]
}
```

可以在 `workspaces` 中添加多个工作区。每个 `id` 需要保持唯一，并使用字母、数字、下划线或连字符。

## 数据目录

```text
~/.pi-ark/
  config.json
  tls/

<workspace>/.pi-ark/
  config.json
  sessions/
```

pi 自身的凭证、模型和全局 resources 继续由 pi 的 agent 目录管理。Pi-Ark 不复制这些敏感数据。

## 安全说明

Terminal 与 pi tools 使用 Pi-Ark 服务进程的系统权限。建议使用专用系统账号运行公开网络中的部署，并只配置该账号可以访问的工作区。全局配置和工作区的 `.pi-ark` 目录应保持为服务账号私有。

详细设计位于 `docs/architecture.md`，pi 集成调研位于 `docs/research.md`。
