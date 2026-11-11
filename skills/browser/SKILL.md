---
name: browser
description: 用 Playwright MCP 操作浏览器完成这些操作（打开网页、读取页面快照、点击、输入、等待异步加载、截图）。适用于网页检查、表单填写、界面操作验证和保存页面证据。
---

# 浏览器操作

## 前置条件

- `playwright` MCP server 已在 Settings 的 MCP 页面启用，`exposure` 为 `codemode`。
- 浏览器运行时已安装到服务用户的 Playwright 缓存目录。
- 在 codemode 脚本里调用这些工具。脚本失败时先读取 `Script error` 的内容，再调整参数重试。

## 查找工具

`playwright` server 提供一组 `browser_*` 工具。编写脚本前先确认工具名称与参数：

```js
const namespace = await describeNamespace("playwright");
if (!namespace) {
  text("playwright 工具不可用。请确认 Settings 的 MCP 页面已启用 playwright server，并已安装浏览器运行时。");
  exit();
}
text(namespace.tools.join("\n"));
```

- `describeNamespace("playwright")` 返回该 server 的说明与工具标识符列表（`mcp__playwright__...`）。
- `searchTools("open page snapshot click type screenshot", { namespace: "playwright", limit: 12 })` 按用途查找工具，返回 `{ name, description }` 数组。
- `describeTool("mcp__playwright__browser_click")` 返回单个工具的完整参数声明。
- 工具标识符格式为 `mcp__playwright__<tool>`，在脚本里通过 `tools.mcp__playwright__<tool>(args)` 调用。
- 工具参数以 `describeTool()` 的结果为准，本 skill 里的参数示例对应 `@playwright/mcp` 0.0.85。

## 操作流程

1. 在一个 codemode 脚本里完成本轮操作（打开页面、获取快照、定位元素、点击或输入、等待结果、输出快照或截图），减少模型往返。
2. 打开页面后先调用 `browser_snapshot` 读取页面快照，再按快照里的元素引用执行点击或输入。浏览器状态在同一 Session 的后续脚本里保持。
3. 点击与输入使用快照里的 `target`。在 `element` 里填写人类可读的元素描述，用于确认操作对象。
4. 页面依赖异步加载时，用 `browser_wait_for` 等待目标文本出现或消失，再获取新的快照确认结果。
5. 页面快照比截图更适合定位元素与验证页面结构。截图用于展示页面外观和保存页面证据。
6. 需要保存页面证据时使用整页截图（`fullPage: true`）；需要表达当前屏幕时使用视口截图（省略 `fullPage` 或设为 `false`）。
7. 用 `text()` 输出文本结果，用 `image()` 输出截图。两者可以按操作顺序写在同一个脚本里。

常用工具与关键参数：

| 工具 | 关键参数 | 用途 |
|---|---|---|
| `browser_navigate` | `url` | 打开网页 |
| `browser_snapshot` | 参数（`target`、`depth`、`filename`） | 读取页面快照与元素引用 |
| `browser_find` | 查询参数（`text`、`regex`、`maxResults`） | 在大页面里定位元素与引用 |
| `browser_click` | 参数（`element`、`target`、`doubleClick`、`button`） | 点击元素 |
| `browser_type` | 参数（`element`、`target`、`text`、`submit`、`slowly`） | 在可编辑元素里输入文本 |
| `browser_wait_for` | 参数（`text`、`textGone`、`time`） | 等待目标状态（文本出现、文本消失、指定时间过去） |
| `browser_take_screenshot` | 参数（`fullPage`、`type`、`filename`、`target`） | 按范围截取页面（整页、视口、元素） |

## 脚本示例

下面的脚本打开页面，获取快照，在搜索框输入并提交，等待结果后输出快照与整页截图。示例使用唯一选择器定位搜索框；操作其他页面时，把 `target` 替换为快照里的元素引用或该页面上的唯一选择器。

```js
function outputText(result) {
  const parts = (result.content ?? [])
    .filter((item) => item.type === "text")
    .map((item) => item.text);
  if (parts.length) text(parts.join("\n"));
}

function outputImages(result) {
  for (const item of result.content ?? []) {
    if (item.type === "image") image(item);
  }
}

const namespace = await describeNamespace("playwright");
if (!namespace) {
  text("playwright 工具不可用。请确认 Settings 的 MCP 页面已启用 playwright server，并已安装浏览器运行时。");
  exit();
}

const opened = await tools.mcp__playwright__browser_navigate({ url: "https://en.wikipedia.org" });
outputText(opened);

const before = await tools.mcp__playwright__browser_snapshot({ depth: 8 });
outputText(before);

const typed = await tools.mcp__playwright__browser_type({
  element: "搜索框",
  target: "input[name=search]",
  text: "Playwright",
  submit: true,
});
outputText(typed);

await tools.mcp__playwright__browser_wait_for({ text: "Playwright" });

const after = await tools.mcp__playwright__browser_snapshot({ depth: 8 });
outputText(after);

const screenshot = await tools.mcp__playwright__browser_take_screenshot({ type: "png", fullPage: true });
outputText(screenshot);
outputImages(screenshot);
```

## 截图输出

- `browser_take_screenshot` 未传入 `filename` 时把图片作为 image result 返回。遍历返回值的 `content`，对 `type` 为 `image` 的项调用 `image()`，模型才能看到图片。
- 传入 `filename` 时图片保存到指定文件，工具返回文件结果。需要同时展示图片时，另做一次未传入 `filename` 的截图调用。
- 整页截图适合保存完整页面内容作为证据。视口截图适合展示用户当前看到的区域，也能避免超长页面生成过大的图片。
- 截取指定元素时传入该元素的 `target`，此时不要同时传入 `fullPage: true`。

## 等待异步加载

- 等待目标文本出现：`browser_wait_for({ text: "加载完成" })`。
- 等待加载提示消失：`browser_wait_for({ textGone: "加载中" })`。
- 需要等待固定时间时使用 `time`，单位为秒，上限为 30 秒。`time` 与 `text` 或 `textGone` 同时提供时充当超时时间。
- 等待结束后重新调用 `browser_snapshot` 获取最新元素引用，再执行下一步操作。

## 错误处理

- 脚本失败时结果以 `Script failed` 开头，并保留失败前的部分输出，末尾是 `Script error:` 与错误信息。先读取错误信息与部分输出，再用 `describeTool()` 核对工具名称和参数，调整后重试。
- 工具调用返回 `isError: true` 时，先输出返回的文本错误，再决定是否调整参数重试。
- 脚本调用抛出 `Error` 时，错误文本包含工具返回的错误内容。需要保留其他调用的结果时，用 `Promise.allSettled()` 收集每个调用的结果。
- `describeNamespace("playwright")` 返回 `undefined` 或工具列表为空时，先确认 Settings 的 MCP 页面里 `playwright` server 已启用且没有错误，再确认浏览器运行时已安装。启用 server 与安装浏览器运行时都完成后，新 Session 才能使用最新配置。
