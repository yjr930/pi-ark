# Pi-Ark 架构设计

## 产品定位

Pi-Ark 是一个常驻的全局 Web 服务。用户通过浏览器选择已配置的工作区，并在该工作区中使用 pi agent、浏览文件、阅读 Markdown 和操作命令行。

每个 agent 会话固定归属于一个工作区目录。Pi-Ark 将工作区的会话和界面配置保存在 `<workspace>/.pi-ark/`，同时继续允许 pi 从工作区的 `AGENTS.md` 和 `.pi/` 读取原生资源。

## 系统结构

```text
Browser
  ├─ Chat workspace (React)
  ├─ File and Markdown reader
  └─ xterm.js terminal
        │ HTTPS + secure cookie + WebSocket
Pi-Ark server (Fastify)
  ├─ Local authentication
  ├─ Workspace registry and path guard
  ├─ Agent session service
  │    └─ @earendil-works/pi-coding-agent SDK
  ├─ File service
  └─ PTY service
        │
        ├─ ~/.pi-ark/config.json             global service configuration
        ├─ ~/.pi/agent/                      pi credentials and global resources
        └─ <workspace>/.pi-ark/
             ├─ config.json                  workspace UI configuration
             └─ sessions/*.jsonl             pi sessions
```

## 服务端模块

- `config`: 读取全局服务配置，解析 TLS、认证和工作区注册信息。
- `auth`: 使用 scrypt 密码摘要验证本地用户，并签发内存会话 cookie。
- `workspaces`: 将浏览器传入的工作区 ID 映射到服务端允许的绝对目录。
- `agents`: 使用 pi SDK 创建、恢复、列出和中止会话，并把 SDK 事件广播给浏览器。
- `files`: 在工作区边界内列出目录和读取文本文件，解析真实路径以阻止符号链接越界。
- `terminal`: 在选定工作区中创建 PTY，并通过 WebSocket 转发输入、输出和窗口尺寸。

## 数据与生命周期

全局配置位于 `PI_ARK_HOME/config.json`，默认的 `PI_ARK_HOME` 是 `~/.pi-ark`。该配置保存监听地址、TLS 证书路径、单用户认证摘要和允许访问的工作区列表。

工作区首次使用时，服务端创建 `.pi-ark/sessions/` 和 `.pi-ark/config.json`。`SessionManager.create(cwd, sessionDir)` 将新会话直接写入该目录，`SessionManager.list(cwd, sessionDir)` 负责会话列表，`SessionManager.open(path)` 负责恢复会话。

服务进程为已打开的 agent 会话保存一个运行时实例。浏览器断线不会中止正在执行的 agent，重新连接后可以读取 session manager 中的消息快照。服务退出时会中止和释放所有运行时实例。

## 安全设计

- HTTP 服务使用配置文件指定的 TLS 私钥和证书。
- 登录接口验证本地配置的用户名和 scrypt 密码摘要。
- 登录状态使用 `HttpOnly`、`Secure` 和 `SameSite=Strict` cookie。
- 所有 API 和 WebSocket 连接都执行认证检查。
- 文件接口将用户路径解析为工作区中的真实路径，并设置读取大小上限。
- 工作区目录来自全局配置，浏览器不能提交任意目录。
- Web terminal 继承 Pi-Ark 服务账号的系统权限，因此部署时应使用专用系统账号。

## 前端结构

桌面布局使用三列结构：工作区与会话侧栏、主内容区、上下文面板。主内容区在 Agent、Files 和 Terminal 页面之间切换。移动端将侧栏转换为抽屉，将输入框和页面工具栏固定在适合触摸操作的位置。

视觉设计采用克制的深色界面、细边框、低饱和强调色和紧凑的信息层级。Markdown 阅读区域采用接近 Obsidian 的排版宽度、标题节奏、引用块、代码块和表格样式。

## 扩展方向

后续版本可以增加 session 分支界面、模型选择器、图片消息、文件修改预览、Git 状态面板和服务级审计记录。
