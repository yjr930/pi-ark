---
name: provider-plugins
description: 安装、更新或卸载 Pi-Ark 的自定义 Provider 插件，并在 Settings 中创建和维护 Provider 实例。适用于用户要求接入中转站、修改 Provider 插件的 base URL 或模型列表、编写新的中转站插件、或排查自定义 Provider。
---

# Provider 插件

Provider 插件定义一种 Provider 类型，例如 Right Code。用户可以在 Settings 中基于同一个插件创建多个 Provider 实例，每个实例对应一个渠道，拥有自己的名称与 API key。插件文件与实例数据分开保存。

## 文件位置

- 插件目录：`$PI_ARK_AGENT_DIR/provider-plugins/`，一个 JSON 文件是一个插件，文件名去掉 `.json` 就是插件 id。
- 默认插件：首次初始化时写入 `$PI_ARK_AGENT_DIR/provider-plugins/rightcode.json`。之后删除该文件不会在启动时自动恢复。
- 实例文件：`$PI_ARK_AGENT_DIR/provider-instances.json`，由 Pi-Ark 在 Settings 操作时维护。
- 安装标记：`$PI_ARK_AGENT_DIR/.pi-ark-provider-plugins.json`，只用于首次初始化，不要修改。
- API key 由 pi 的 credential store 保存在 `$PI_ARK_AGENT_DIR/auth.json`，实例 id 是 credential 的 Provider id。不要手写或读取 key。

插件文件只允许小写字母、数字、下划线和连字符作为文件名，例如 `my-relay.json`。插件 JSON 不写注释。

## 插件格式

```json
{
  "version": 1,
  "name": "My Relay",
  "description": "OpenAI-compatible relay",
  "baseUrl": "https://relay.example.com/v1",
  "api": "openai-completions",
  "models": {
    "url": "https://relay.example.com/v1/models",
    "format": "openai",
    "auth": ["bearer"],
    "fallbackToMetadata": false
  },
  "protocols": [
    { "match": "^claude", "kind": "messages", "api": "anthropic-messages", "baseUrl": "https://relay.example.com" }
  ],
  "defaultProtocol": { "kind": "completions", "api": "openai-completions", "baseUrl": "https://relay.example.com/v1" },
  "modelDefaults": {
    "input": ["text"],
    "reasoningMatch": "^(claude|gpt|codex|gemini|grok)",
    "contextWindow": 128000,
    "maxTokens": 16384,
    "contextWindowRules": [{ "match": "^(gpt|codex)", "value": 272000 }],
    "maxTokensRules": [{ "match": "^gemini", "value": 65536 }]
  }
}
```

字段说明：

- `version`：固定为 `1`。
- `name`：Provider 类型的显示名，例如 Right Code。
- `description`：Settings 添加 Provider 时显示的说明。
- `baseUrl`：Provider 的默认 API 地址。
- `api`：默认 API，可选 `openai-completions`、`openai-responses`、`anthropic-messages`、`google-generative-ai`。
- `models.url`：返回模型列表的地址，按 OpenAI 的 `{ "data": [{ "id": "..." }] }`、`{ "models": [...] }` 或数组解析。
- `models.format`：目前只支持 `openai`。
- `models.auth`：请求模型列表时使用的鉴权方式，可以是字符串或数组。可选 `bearer`、`x-api-key`、`x-goog-api-key`、`none`。按顺序尝试，前一个返回 401 或 403 时再试下一个。
- `models.metadataUrl`：可选，用于补充价格、上下文窗口与支持的协议。当前支持 Right Code 的公共目录格式。
- `models.metadataFormat`：使用 `metadataUrl` 时必须设为 `rightcode-public`。
- `models.fallbackToMetadata`：模型列表请求失败或为空时，是否使用公共目录中的 chat 模型名称。
- `protocols`：按顺序匹配模型 id 的规则。第一个 `match` 正则命中的规则决定模型使用的 `api` 与 `baseUrl`。`kind` 取 `responses`、`messages`、`completions` 或 `gemini`。
- `defaultProtocol`：没有规则匹配时使用的协议。
- `modelDefaults.input`：模型输入类型，`text` 或 `image`。
- `modelDefaults.reasoning`：默认是否支持 thinking。
- `modelDefaults.reasoningMatch`：匹配的模型使用 thinking。
- `modelDefaults.contextWindow` 与 `modelDefaults.maxTokens`：默认上下文窗口与最大输出。
- `modelDefaults.contextWindowRules` 与 `modelDefaults.maxTokensRules`：按模型 id 正则覆盖默认值。
- `modelDefaults.compat`：应用到所有模型的 pi API 兼容字段。
- `modelDefaults.compatRules`：按模型 id 正则覆盖 `compat`，例如 `{ "forceAdaptiveThinking": true }`。
- 公共目录中的价格与上下文窗口会覆盖 `modelDefaults` 的默认上下文窗口。

`models.url` 与 `models.metadataUrl` 至少提供一个。Right Code 同时使用两个。

## 安装与重载

1. 在 `$PI_ARK_AGENT_DIR/provider-plugins/` 写入新的 `<id>.json`，或在已有插件上修改字段。
2. 用 `node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' <path>` 检查 JSON 语法。
3. 让用户在 Settings → Models & providers 点击 Reload provider plugins。这个动作重新读取插件与实例，并应用到 Settings。插件文件错误会显示在 Add custom provider 对话框。
4. 新 Session 会读取最新插件。已有空闲 Session 会随 Provider 变化重新加载；正在运行的 Session 需要用户在 Composer 执行 `/reload`。

修改插件的 `baseUrl`、`models.url` 或 `protocols` 后必须点击 Reload provider plugins。重新加载会让该插件实例的模型缓存失效，用户需要再点击 Refresh models。

## 添加 Provider 实例

实例由用户在 Settings 中创建，不要手写 `provider-instances.json`，除非用户明确要求迁移或修复数据。

1. 打开 Settings → Models & providers。
2. 点击 Add custom provider。
3. 在 Provider type 选择插件，例如 Right Code。
4. 在 Provider name 输入渠道名。这个名称会显示在 Provider 列表和 Composer 的模型选项中，例如 `RightCode Claude 官渠`。
5. 粘贴该渠道的 API key，点击 Add provider。
6. 选中新 Provider，点击 Refresh models。模型列表来自插件的 `models.url`；勾选需要的模型并设置 default model。

同一个插件可以创建多个实例。实例 id 由 Provider name 生成的小写 slug 决定，遇到冲突会追加数字后缀。修改 Provider name 不会自动修改已有实例 id。

## 维护 Provider 实例

- API key：选中 Provider 后在 API key 输入框保存，使用 Save API key。保存后点击 Refresh models 重新获取该 key 可用的模型。
- 模型：在 Models shown in Pi-Ark 勾选；星标决定新 Session 的 default。
- Refresh models：重新请求插件的模型列表。上游新增模型后执行一次即可，不需要修改插件文件。
- Disconnect：删除该实例保存的 API key，保留实例。
- Delete provider：删除实例、API key 与模型选择。插件文件保留，用户可以用同一插件创建新实例。

## 卸载与恢复

卸载插件是文件操作，不需要 UI 按钮。

1. 把 `$PI_ARK_AGENT_DIR/provider-plugins/<id>.json` 移动到回收目录，例如 `/root/.recycle_bin/`。不要删除 `provider-instances.json`，也不要删除安装标记。
2. 让用户点击 Reload provider plugins。使用该插件的 Provider 实例会暂时从 Provider 列表消失。
3. 重新安装时把插件 JSON 放回目录，再点击 Reload provider plugins。原实例会恢复，API key 仍在 credential store 中。
4. 用户要永久删除实例时，在恢复插件后到 Settings 的 Provider 列表点击 Delete provider，或按用户指示清理 `provider-instances.json`。

删除插件不会影响 Pi-Ark 本身，也不会影响 `models.json` 中已有的 Provider。

## Right Code 插件

模板文件是与本 SKILL.md 同目录的 `rightcode.json`。卸载后要恢复默认插件时，把该模板复制到 `$PI_ARK_AGENT_DIR/provider-plugins/rightcode.json`，再让用户点击 Reload provider plugins。

默认 `rightcode.json` 的要点：

- 地址：`https://rightapi.io/v1`；模型列表：`https://rightapi.io/v1/models`；公共目录：`https://rightapi.io/models/public`。
- Right Code 的 API key 在创建时绑定渠道，只能调用该渠道下的模型。每个渠道创建一个 Provider 实例，使用对应渠道的 key。
- 协议映射：Claude 使用 Messages，GPT、Codex 与 Grok 使用 Responses，Gemini 使用 Gemini 原生，DeepSeek、GLM、Kimi 与 MiniMax 优先 Messages。
- 公共目录提供价格、上下文窗口与支持的协议；模型列表来自该 key 的 `/v1/models`。
- `models.auth` 依次尝试 `bearer`、`x-api-key`、`x-goog-api-key`，以适配不同渠道的 key。
- Claude 5、Opus 4.7 与 Opus 4.8 使用 adaptive thinking，模板在 `modelDefaults.compatRules` 中为这些模型设置 `forceAdaptiveThinking: true`。Opus 5.5 缺少该设置时会返回 `requires adaptive thinking` 400；不要只设置 `reasoning: true`。
- 旧的 Claude 模型如果需要 budget thinking，保持 `compatRules` 不匹配这些模型。

用户更新了 Right Code 的地址或模型规则时，直接编辑 `rightcode.json` 并点击 Reload provider plugins。不要修改 Pi-Ark 的源码。

## 排查

- Add custom provider 没有可选类型：检查插件目录是否有合法 JSON 文件，文件名是否符合规则。
- 插件显示错误：修正 JSON 字段或正则，点击 Reload provider plugins。
- 实例消失：插件文件被移动或删除。恢复插件并 Reload。
- Refresh models 报 Provider rejected the API key：API key 与实例对应渠道不匹配，或 key 已失效。
- Refresh models 没有模型：检查 `models.url`、`models.auth`、`models.format`，以及公共目录是否可用。
- 请求返回 `requires adaptive thinking`：在插件的 `modelDefaults.compatRules` 中为对应模型设置 `{ "forceAdaptiveThinking": true }`，然后 Reload provider plugins。
- 插件已更新但模型仍用旧地址：点击 Reload provider plugins，再点击 Refresh models。
