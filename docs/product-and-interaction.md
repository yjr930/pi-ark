# Pi-Ark 功能与交互设计

## 产品定位

Pi-Ark 是面向个人或受控团队环境的 pi coding agent Web UI。服务端维护允许访问的 Workspace registry，浏览器在一个界面中完成 Agent 对话、文件阅读、命令行操作和配置管理。

原生安装包覆盖 Linux x64/arm64、macOS Intel x64/Apple Silicon arm64 和 Windows x64。macOS 与 Windows 默认安装到当前用户的应用目录，Linux 默认使用专用 service account 与 systemd，也可选择 portable。Portable 的 `start` 在后台运行，关闭启动终端后服务继续运行；稳定 CLI 提供 start、stop、restart、status 与 logs，`serve` 用于前台运行。

每个 Session 固定归属于一个 Workspace。Agent tools、Files 和 Terminal 都以该 Workspace 的绝对目录为工作范围。

## 设计原则

- Workspace 是文件与 Session 的组织范围；设置由 Global 统一管理。
- Provider 凭证、默认 model 和服务外观属于 Global scope。
- Session 可以覆盖当前对话使用的 model 和 thinking level，同时保留 Global default。
- 破坏性操作使用确认对话框，并明确说明将保留或删除的数据。
- 长内容和工具执行过程逐层折叠，最终回答与重要状态保持可见。
- URL 保存当前页面、Workspace、Session 和目标 Message ID，使浏览器刷新和分享链接可以恢复位置。
- 同一个 hostname 可以通过不同的 base path 提供多个实例；每个实例拥有独立的 Global settings、provider credentials 和登录状态。
- 多个实例可以共享 Workspace `.pi-ark` state；用户在同一时刻从一个实例操作指定的 Session。
- 所有列表、选择器、对话框和确认操作使用 Pi-Ark 组件，并保持一致的紧凑尺寸。

## 信息架构

登录后的应用由侧栏和主内容区组成。

侧栏包含以下区域：

1. Workspaces：选择、添加、重命名和关闭 Workspace。
2. 页面导航：Agent、Files、Terminal 和 Settings。
3. Sessions：打开 Notebook、选择 Session，并通过标题栏按钮显示归档 Session、打开内部链接、新增 Session group 和新建 Session。

主内容区根据当前页面展示对应功能。URL query 保存页面与选择状态；Session 和 message 也可以使用 `pi-ark://` 内部链接定位。

## Workspace

### 添加 Workspace

用户通过 Workspaces 标题旁的加号打开 Add workspace 对话框。目录必须是服务端已经存在、服务账号可以访问的绝对目录。目录输入会请求服务端建议，并允许用户设置显示名称。

添加成功后，Pi-Ark 将 Workspace 写入 Global registry，创建 `<workspace>/.pi-ark/` 状态目录，并切换到新 Workspace。

### 重命名与关闭

Rename 只修改侧栏显示名称。Workspace ID 和目录路径保持不变。

Close 从 Global registry 中取消注册。确认对话框明确显示 Workspace 名称和路径；项目文件、附件和 Session 继续保留在服务器目录中。关闭 Workspace 时，Server 释放该 Workspace 的 Terminal 进程和输出，浏览器释放对应的 Terminal 页面。

### 空 Workspace 状态

Registry 为空时，主内容区显示 No open workspace，并提供 Add workspace 操作。Settings 的 Global 页面仍然可用。

## Session 管理

### Session 列表

Session 标题优先使用用户设置的名称，其次使用首条 user message。每个 Session 使用单行 row，标题在可用宽度内省略；列表不直接显示日期，悬停 Session row 时通过原生 tooltip 显示 `Last Updated: xxxx-xx-xx xx:xx:xx`。置顶 Session 额外显示 Pin 图标。

Session row 的右侧状态区域使用以下优先级：Agent 正在运行时显示 warning color spinner；最近一次 Agent run 以 error 结束时显示 danger color 感叹号；Session 处于 Ready 且有尚未查看的输出时显示绿色 unread dot。Running 和 Error 期间暂时隐藏 unread dot，未查看的输出记录继续保留，回到 Ready 后恢复对应的提示。在可见的 Agent 页面查看对应 Session 后，当前浏览器确认当时的更新序号并清除 unread dot。较旧的状态响应会保留已经确认的查看进度。Error 状态持续到下一次 Agent run 更新状态。状态和已查看记录继续保存在当前 Server process 与浏览器页面内存中。

当前 Web Agent runtime 没有显式 question lifecycle。Question indicator 是计划能力，后续在 runtime 提供 question state 和 answer API 后加入 Sidebar 状态优先级。

每个 Session 提供以下操作：

- Rename：修改 Session 标题。
- Copy session link：复制 `pi-ark://` 内部链接。
- Manage groups：将 Session 同时分配到多个 group。
- Pin 或 Unpin：调整活跃 Session 的置顶状态。
- Archive 或 Restore：在活跃区域和 Archived 区域之间移动 Session。
- Delete：确认后删除 pi JSONL、Session metadata 和对应附件目录。

### Session group

Sessions 标题栏右侧依次显示 Show archived sessions、Open Pi-Ark session link、New session group 和 New session 四个图标按钮。用户可以创建、重命名和删除 group。一个 Session 可以出现在多个 group 中；未分配 group 的 Session 显示在 Ungrouped。删除 group 会移除 group 本身及 Session 的对应关联，不会删除 Session。

### Workspace Notebook

原 New group 独立栏位显示 Notebook 入口。打开后，主内容区显示当前 Workspace 的纯文本 Markdown 笔记编辑器；输入停止约 300 ms 后自动保存，离开输入框或页面时立即提交尚未保存的内容。Header 显示 Loading notes、Saving、Saved 或 Save failed。每个 Workspace 使用独立的 `.pi-ark/notebook.md`，再次打开 Notebook 时恢复保存内容。

### 新建与选择

新建 Session 后，应用切换到 Agent 页面并打开新 Session。尚未发送 message 的 Session 不进入侧栏列表；发送首条 message 后，该 Session 立即出现在侧栏列表，标题使用这条 message 的文本。在未发送状态切换到别的 Session 或 Workspace 后，再次点击 New session 会回到这个未发送的 Session，Composer 中尚未发送的内容随之恢复。切换 Workspace 时，应用优先恢复 URL 指定的 Session，其次恢复该 Workspace 上次查看的 Session，最后选择第一个未归档的普通 Session，并把选中的 Session 写回 URL。Session 列表加载期间，主内容区显示 Loading sessions，侧栏不显示其他 Workspace 的 Session。侧栏的 Session 列表展示普通 Session，subagent 通过会话状态栏的列表与内部链接进入。

## Agent conversation

### 加载状态

首次打开 Session 且浏览器没有内存 cache 时，WebSocket 建立后页面继续显示 Loading conversation。首个 snapshot 到达前，欢迎内容和 composer 保持隐藏，Session 相关的 header controls 保持 disabled。进度条采用 indeterminate 样式，因为服务端不提供百分比。

浏览器在内存中保存最近五个 Session 的 snapshot 和 Session UI state。切回这些 Session 时，页面立即显示缓存 conversation 和 controls，状态显示 Refreshing conversation，并在后台连接 Server；权威 snapshot 到达后替换缓存内容。UI state 恢复 composer 中尚未发送的 text、attachments，以及 Running、Tool、Reasoning、Compact 和 Message Info 的展开或折叠状态。该 cache 不写入 localStorage，浏览器刷新后重新加载。切换 Session 时，旧 WebSocket 的后续事件不会更新新 Session。

Server 初始 snapshot 默认只包含最新约 100 条 messages，并提供完整 projection 的全局 offset 和总数。顶部 Show earlier messages 每次请求 Server 将当前 client 的 display window 向前扩展一页，直至显示完整活动 branch。

### 空 Session 与运行状态

没有 message 的 Session 显示欢迎内容和 composer。发送 message 后，user message 通过流式 event 立即进入 conversation；Server 在 message 持久化完成后发送权威 snapshot。会话状态栏左侧依次显示标题、编辑标题按钮和状态；标题组不占用剩余空间；标题使用实际文字宽度并受当前 max-width 限制，编辑按钮紧跟标题。右侧只显示 context 百分比数字和 Session information。复制 Session URL 与 conversation width 选项位于 Session information panel。状态在连接、加载、工作、运行工具、就绪和连接错误之间变化。Disconnected、Connection error 和其他错误状态使用完整红灯，并增加红色系底色和边框；移动端只省略过长的状态文字，不裁切红灯。移动端 Chat 主列始终限制在 viewport 内，header、conversation、sticky User row、Running 和 composer 不产生页面横向溢出。

每个 turn 的 User 内容显示为一条独立的全宽色带，并保留用户头像、`User` 标签、短 Message ID、内部链接与 Rollback。User 色带使用与 conversation 和 AI feed 有区分的 theme background，只有上、下 separator，没有左右 border、圆角或阴影；色带延伸到当前 conversation 内容列的左右边界。上下 separator 的外侧保留更大的垂直间距。色带内部使用非对称 padding，其中左侧和上侧的留白大于右侧和下侧。Ark Dark、Graphite、Midnight、Paper 和 Snow 分别使用与自身背景和 AI accent 协调的 User palette；User accent 与 AI accent 保持可区分。User 与 AI 的头像和名称都使用更大的尺寸。该轮 AI response 只在开头显示一次 AI 头像和 `AI` 标签，后续 text、image、reasoning、tool 与 Compact items 按原始顺序连续排列。User 与 AI 的角色头像只占用 header 行，后续 feed 内容继续使用 conversation 的完整宽度。

正在执行的 turn 将 commentary、tool call 和 tool result 放入带 Running 状态和工具消息数量的 run collapse。没有该 Session 的已保存 disclosure 状态时，Running 默认展开，最新的非工具 assistant output 保持可见。Agent settled 后，该 run collapse 自动折叠并显示用时和工具消息数量，最后一条非工具内容保持展开。用户随后手动改变的折叠状态在 Session 切换后恢复。

Agent settled 且缺少最后一条非工具内容的历史 turn 在 run collapse 后显示紧凑的 Response interrupted warning。该 turn 因 provider error 结束时，warning 在标题下方显示 Session 保存的 errorMessage；内容为空的失败 assistant message 在 AI 标题下显示同一错误，而不是空白回复。Automatic retry 进行期间，conversation 底部显示带 attempt 和错误原因的 Retrying warning，retry 完成后清除。运行结束后，Session status 为 error 时，chat header 的状态显示 Error，并在 tooltip 中给出保存的错误原因。

### 工具展示

Conversation renderer 将内容投影为 text 与 tool 两类 feed items。Text item 包含普通文字、图片和 reasoning，并直接显示在连续 feed 中；reasoning 使用较小字号和与普通 text 一致的行高。Global Hide reasoning 启用后，conversation 隐藏 reasoning disclosure 和内容，同时保留 Session history 中的原始 reasoning。含普通 text 或 image 的 assistant source message 在末尾显示操作行：已完成的 message 默认显示 Copy Markdown、Fork session 和 Info，流式 message 显示 Info。操作行的左侧显示该消息的时间，格式为 `YYYY-MM-DD HH:mm:ss`，使用浏览器所在的时区；操作按钮保留在右侧。只包含 reasoning 和 toolCall 的 message 不显示该操作行。Info 控制的信息栏默认折叠，展开后显示 source Message ID、内部链接、model、context 和 input/output token；流式 message 只显示当前可用的信息。

每个 tool call 与对应 tool result 合并为一行 tool item。工具 logo 位于折叠框的 summary 内，后面依次显示工具名称、实际摘要和状态；展开内容与折叠框左边界对齐。Completed 使用中性色；Running 使用 warning color，Failed 使用 danger color，Result 使用 info color，Saved 使用 saved color。状态颜色作用于同一层折叠框的 border、logo 和状态文字，Running 不增加外层背景或包围框。Tool permalink target 使用折叠框内侧的 accent 标识，不改变 row 的外部尺寸。所有 themes 都将大 Run group 与内部 Tool row 分成两层 palette：Run group 使用 theme tint，Tool row 和 Reasoning 使用更亮、更中性的 surface。Paper 的 Run group 使用低饱和 sage-gray tint，Tool row 使用浅白色；其他 themes 使用相同的外层 tint、内层 neutral 逻辑。bash 优先显示 command，文件工具优先显示 path，其他工具显示 query、pattern、URL、紧凑 arguments 或 result 文本。连续 tool items 使用紧凑的内部上下间距和行间距。

Tool item 在没有已保存 disclosure 状态时默认关闭；active Running 默认展开时，正在 Running 的 tool item 和已完成的最新 tool item 都保持关闭，用户仍可手动展开。切换 Session 后，页面恢复用户对 Tool、Reasoning、Compact 和 Message Info 的展开状态。已完成 tool item 的 message permalink target 在没有用户保存状态时自动展开对应 tool item。展开后第一行显示 Call/Result 的消息 link 按钮，整段文字与图标区域都可以复制对应的 `pi-ark://` link；tooltip 在页面浮层中显示，下面按 Arguments 和 Result 显示参数与文字或图片结果。Arguments 不显示整段 JSON；每个 key 使用更深一层的 heading 样式，value 在下一行，嵌套 object/array 使用缩进文本，空 arguments 显示 `No arguments`。展开内容的底部左侧显示最后的时间，格式为 `YYYY-MM-DD HH:mm:ss`，使用浏览器所在的时区；已有结果时采用配对的 tool result 时间，等待结果期间采用 tool call 所在消息的时间。错误结果显示 Failed 状态和错误颜色。

连续的工具调用按可见内容分组，默认保留最后 3 个 tool call；较早的调用通过 `show more tool call` 与 `show less tool call` 展开或折叠。一个 message 中的多个调用分别计数。Hide reasoning 开启后，分组会跳过隐藏的 thinking block，包括只包含 thinking 的独立 message，因此这些内容前后的连续调用归入同一分组。可见的 Reasoning、普通正文、图片、Compact、branch summary 和独立结果继续中断分组，含普通正文或图片的 message 保持原有显示。分组保留原始 message 与 permalink，展开状态随 Session UI cache 保留，较早调用的 permalink target 会在首次访问时展开对应分组。

`subagent` tool 的收起高度为普通 tool row 的 3 倍，并使用分支 logo；该 tool 独立于连续 tool call 的分组显示。包含 `subagent` 调用的 message 中断前后普通调用的连续分组，同一 message 中的混合调用按原顺序保留。

Compact 的收起高度为普通 tool row 的 3 倍。收起时显示 Duration、Before、After、System prompt、Summary、Retained 和 Saved；After 与各组成的 token 用量使用 pi SDK 估算，并以 `≈` 标记。展开后显示 source Message ID、内部链接、压缩触发原因、生成摘要的 input/output token 用量，以及 pi 保存的 Markdown summary。耗时来自 Server 对后续压缩事件的记录。历史字段使用已有记录展示，空字段显示 `—`；System prompt 尚未记录时，After 显示已知部分并附加 `+ system`。compact 前的原始会话继续通过 earlier message 分页展示。

页面中的短 Message ID 统一使用斜体，包括 User header、sticky User 和消息信息按钮。Tool call message 与 tool result message 继续保留各自的短 Message ID、source entry ID 和 permalink anchor。Permalink 指向其中任一 source message 时，外层 run collapse 和对应 tool item 自动展开。

### Message 标识与链接

每条持久化 snapshot message 使用 Session 内唯一的七字符短 Message ID，格式为 `m` 加六位小写 base36，例如 `m04k9z2`。Server 根据 Session ID 与 source entry 在 append-only Session entries 中的固定位置，通过 31-bit 一一映射生成 ID；ID 不写回 pi JSONL。单个 Session 最多支持 10000000 个 source entries，达到上限后 Server 拒绝新的 prompt。User header、assistant text 的 Info 信息栏与 tool item 的展开内容只提供 `pi-ark://` message link copy 按钮，不提供绝对浏览器 URL copy 按钮。内部链接可以通过侧栏的 Open Pi-Ark session link 对话框打开；带 Message ID query 的浏览器 URL 可以定位并高亮目标 source message。旧的纯数字 message target 继续按原 display position 解析，并由 Server 返回对应的短 Message ID。

### Agent 读取内部链接

Agent 自带 `read_pi_ark_link`，用户可以在消息中提供 Pi-Ark 的 Workspace、Session 或 Message link。工具按当前服务的 Workspace registry 解析目标，并返回目标内容及其来源标识。Message link 接受短 Message ID 和旧数字目标，返回的 Message link 使用短 Message ID。工具与页面共用完整活动分支的 display projection，因此也可以读取 compact 之前的消息。

Workspace link 返回 Session 摘要。Session link 默认返回末尾 20 条消息，并提供从 1 开始的 `start` 与最多 100 条的 `limit`。Message link 默认返回目标消息，`context` 可以增加前后各最多 20 条消息。结果包含短 Message ID、source entry ID、当前 display position、role、timestamp 和可用的 model 或 tool 信息。

正文包含文本、reasoning、tool arguments、tool result 和 summary；图片以 MIME type 说明表示。单次结果最多为 48 KiB，较长的正文通过 `nextContentOffset` 和 `offset` 继续读取，更多条目通过分页位置继续读取。读取保持目标 Session 的运行状态与活动分支。

### Subagent 任务

Agent 可以通过 `subagent` 委派独立任务。新建的子 Session 继承本次委派的模型与 thinking level，并在同一个 Workspace 中工作；父 Agent 可以通过工具的可选 `sessionId` 继续向已有的子 Session 发送任务，已有的子 Session 保留自身的上下文与配置。每次委派支持 1–8 个任务，每个父 Session 同时执行的任务上限为 4，服务实例同时执行的任务上限为 8。

存在 subagent 时，父会话的状态左侧显示分支 logo 与 `running / complete / total` 数量。数量按子 Session 合并，`running` 统计最新状态为 `running` 的子 Session，`complete` 统计最新状态为 `completed` 的子 Session，`total` 统计保留的子 Session。点击 logo 可以展开或收起 agent 列表。

列表中每个 agent 使用一行，内容为标题、状态与最后更新时间，点击该行进入对应的子 Session。列表按最后更新时间倒序排列，最大高度为 `32vh` 与 `320 px` 中的较小值，溢出内容在列表内滚动。上方显示 `queued` 与 `running` 的 agent；底部的 Completed 分组包含 `completed`、`failed`、`cancelled` 与 `interrupted` 的 agent。Completed 初始折叠，出现新的结束状态时自动折叠，用户可以手动展开。再次委派后，对应的 agent 回到上方的活动列表，并沿用同一行与数量统计。

子会话的顶部显示 Parent Agent 栏，包含父会话的标题、运行状态与相同的 subagent 数量入口。点击父会话的标题可以返回当前父会话，Open parent request 定位本轮委派时的父消息。子会话的角色名称使用 `Parent Agent` 与 `SubAgent`，消息 header、sticky header 与消息信息栏使用相同名称；角色的配色与头像沿用原有样式，普通会话继续使用 `User` 与 `AI`。

子会话的空消息状态显示 `SubAgent conversation`，并说明 Parent Agent 管理该会话。子 Session 始终隐藏 Composer，后续任务由父 Agent 的工具委派进入。运行中的子任务显示 `The parent is managing this task.`，并提供 Stop；父 Session 的 Stop 会停止其当前等待的子任务。浏览器重连后，snapshot 恢复最新的任务状态；服务中断后，遗留任务显示 `interrupted`。父子 Session 的关系独立于 Session group。

引用与结果链接可以携带 `leafEntryId`，用于保留当时的历史分支。历史页面显示 Historical conversation branch 与 Open current conversation，用户可以切换到当前对话。页面中的内部 Session 或 Message 链接在应用内跳转；带修饰键的点击可以使用浏览器的新标签页操作。历史页面复制的消息链接保留分支参数。

### Composer

Composer 的最大宽度固定为 Compact 宽度。Compact、Wide 和 Full 只改变 conversation message 区域的宽度。Composer 作为 Agent 页面 Grid 的底部行参与布局，queue 增高时 conversation 使用剩余高度。

输入框为空时显示 `Send message here`。输入框会随内容增长，最多显示十行，之后使用内部滚动。Enter 发送，Shift+Enter 换行；输入法正在组合文字时，Enter 交给输入法处理。Send 与 Stop 始终显示；Agent active 时 Send 提交 Follow-up，Session idle 时 Send 提交普通 prompt，Stop 在 Session idle 时为 disabled。

Composer 提供当前 Session 的 model 与 thinking 选择器，选择器直接显示当前值，不显示 `MODEL` 与 `THINKING` 提示文字。Model 列表来自当前可用凭证，Thinking 选项来自所选 model 的 pi capability。选择结果只影响当前 Session。

Conversation 在用户位于底部附近时跟随新输出；用户向上滚动后，后续 event 保留当前阅读位置。User message 的顶部越过 conversation 顶部时，该 message 显示为不透明的 sticky User bar；向上滚动并让原 message 重新进入顶部后，bar 立即切换到前一个 user message。点击 sticky User bar 的任意位置会定位到原 message，并将目标 message 放在 sticky bar 下方且保留 8 px 间距。已经展开的 run collapse summary 以不透明的 sticky row 固定在 User bar 下方。Message permalink 继续使用平滑定位。

### Queue

Session 正在运行时，新 message 默认进入 Follow-up queue。Web 在提交后立即增加本地 Follow-up row 并显示 Scheduling；Server 接受 Queue item 后发送轻量 `queue-state`，正式 row 替换本地 row。提交或连接失败时，本地 row 显示 Failed，并允许用户清除。Queue 区分 Steering 和 Follow-up，并使用紧凑的 message rows 显示文本摘要。

调整顺序、切换消息模式、Edit 和 Merge follow-ups 都先在 Web 中显示 optimistic 结果。Server 使用 operation ID 确认该操作，并通过 Queue revision 更新权威状态；失败时页面恢复 Server 返回的 Queue。Mode 切换后的 item 追加到目标模式分组末尾。Composer 已有文字或 attachments 时，Edit 显示覆盖确认对话框；确认后 row 立即移除，Server response 到达后 queued text 进入 composer。Merge follow-ups 立即按照当前顺序将全部 Follow-up text 显示为一条 Follow-up。Global settings 决定每种 Queue 的默认投递方式。Queue 使用独立的最大高度和滚动区域，并由 composer 所在的 Grid row 占用页面空间。

### 附件与图片

每条 message 最多包含 8 个附件，单个附件最大 10 MB，总大小最大 20 MB。附件按钮支持普通文件和图片；剪贴板中的图片会进入附件队列，普通文字粘贴保持浏览器原生行为。

支持预览的图片格式包括 PNG、JPEG、GIF 和 WebP。发送前显示缩略图和删除操作；发送后的图片可以打开 lightbox。

### Assistant response actions

含普通 text 或 image 的已完成 assistant item 在内容末尾默认提供以下操作；只包含 reasoning 和 toolCall 的 message 不显示操作行。Info 展开的信息栏显示 model、context 使用百分比、`I/input token`、`O/output token`、source Message ID 和内部链接：

- Copy Markdown：复制 assistant response 的文字 Markdown。
- Fork session：从该 response 对应的 session entry 创建新分支，并要求输入新 Session 名称。AI working 时，已经完成并持久化的旧 assistant response 仍可 Fork；原 Session 继续运行。
- Info：展开或折叠该 source message 的信息栏。

### Rollback 与 Restore

Rollback 按钮显示在当前分支最后一条可回退的 user message 上。正常完成的 AI response 使用最后一条完成的 assistant output 作为 rollback target；settled 且显示 Response interrupted 的 response 使用该 turn 最后的 assistant/tool message 作为 fallback target，因此对应 User message 也可以 Rollback。确认后，Pi-Ark 将当前分支移动到该 user turn 之前，将 user message 文本放回 composer，并显示 Restore message。

Rollback 只改变 conversation branch，不修改 Workspace 文件。用户可以恢复原分支，也可以编辑 composer 后发送替代 message；发送新 message 后，Restore message 消失。

### Session information

Header 的 Session information 面板显示创建时间、更新时间、消息数量、context token、context window、context 使用百分比、input token 总量、output token 总量和费用，并提供 Copy session URL 与 Compact、Wide、Full conversation width 选项。复制按钮的文字保持单行，复制完成后的 Session URL copied 也保持单行。桌面端的面板宽度为 350px，窄屏中的面板按屏幕宽度调整；底部空间不足时，复制按钮和 conversation width 控件按整个控件换行排列。

## Files

Files 页面的目录 breadcrumb 横跨文件列表和阅读区域，长目录路径可以使用整个页面宽度。breadcrumb 下方的左侧区域显示目录内容，右侧区域显示选中文件，并在阅读区域顶部单独显示文件路径。目录列表顶部的 Up one level 返回父目录；目录导航始终限制在 Workspace 内。

桌面端可以拖动文件列表与阅读区域之间的 separator，调整后的文件列表宽度保存在浏览器 localStorage。移动端继续使用上下堆叠布局。每个文件和目录右侧的 action menu 可以复制服务器绝对路径或 Workspace-relative path；每个文件的 menu 还提供 Download。

Markdown 文件使用与 conversation 相同的安全 Markdown renderer，并支持相对图片路径。PNG、JPEG、GIF 和 WebP 文件在阅读区域内按可用空间预览，其他文本文件使用代码视图。选中文件的 header 始终提供 Download；binary file 或超过 Workspace 预览上限的文件显示下载状态，不读取文件内容。Global Settings 的 Files 类别可以控制 dotfile 显示和最大预览大小；预览大小默认是 10 MB，可以设置为 1–100 MB。Pi-Ark 自身的 `.pi-ark` 状态目录始终不进入文件列表。

## Terminal

Terminal 页面使用 xterm.js，每个 Tab 在 Workspace 目录中启动独立的 PTY。首次进入当前 Workspace 的 Terminal 时，页面读取已有的 Tab；列表为空时自动创建首个 Tab。Tab 栏使用紧凑的单行布局，活动 Tab 使用中性色背景与细底线，加号紧邻 Tab 列表并提供 New terminal tab。Tab 的标题使用 `Tab 1` 这样的简短名称，并保留独立的关闭按钮。Tab 上的关闭按钮释放对应进程和输出；关闭最后一个 Tab 后，页面显示 No terminal tabs，并提供 New terminal 与 Refresh tabs。

页面顶部显示 Workspace 路径，并提供工具栏操作（Copy、Paste 和 Fit）。Copy 在存在选区时可用，Paste 在当前 Tab 已连接且正在运行时可用。Tab 栏右端的 Terminal details 使用省略号图标；鼠标悬停、键盘聚焦或触屏点击时，悬浮详情显示连接信息及已退出进程的 exit code。普通连接中断后，页面自动重连，连接详情提供 Retry；重新连接时继续接收尚未收到的输出。Escape、外部点击或再次点击 Terminal details 可以关闭详情，切换 Tab 或页面时同样关闭。容器尺寸变化时，终端自动调整行列数；Fit 主动适配当前容器。

工具栏的图标按钮提供 hover 与键盘聚焦说明。复制成功等操作反馈显示为终端区域右上角的紧凑悬浮卡片，并在 2.8 秒后消失；错误反馈保留关闭按钮。提示与连接详情覆盖在页面上方，终端正文的位置和可用高度保持稳定。

粘贴使用系统、浏览器和 xterm 的默认行为，工具栏的 Paste 通过浏览器剪贴板读取文字并交给 xterm 粘贴。Ctrl+Shift+C 或 Cmd+C 复制当前选区，Ctrl+C 沿用终端程序的中断行为。输入法组合文字期间，按键由输入法和 xterm 处理。

App 按已访问的 Workspace 保持 Terminal 页面及各 Tab 的 xterm DOM 挂载。切换 Tab、页面或 Workspace 时隐藏对应的终端界面，返回后立即显示保留的状态（输出、阅读位置和选区）。Server 在当前运行生命周期内保留所有 Tab 的独立进程和完整输出；浏览器刷新后重新连接这些 Tab 并回放历史。shell 自然退出后，Tab 和输出保留到显式关闭；关闭 Workspace 或 Server shutdown 时释放相关资源。

Settings → Terminal 提供共享的 Server shell 设置，以及当前浏览器的字体设置。Server 自动发现可用的 shell profiles，支持以下选择（Auto、Bash、Zsh、Fish、PowerShell、Windows PowerShell、Git Bash、WSL 和自定义程序）。Auto 在 Windows 上优先使用 PowerShell（pwsh），其次使用 Windows PowerShell；在 macOS 上使用有效的 `SHELL`，其次使用 `/bin/zsh`；在 Linux 上使用有效的 `SHELL`，其次使用 `/bin/bash`。PowerShell 启动时设置 UTF-8 编码，Unix 继承有效的 UTF-8 locale，并支持环境变量覆盖。默认字体列表使用系统的等宽字体，浏览器为中文字符选择可用的备用字体。历史默认字体列表在读取时采用新的默认值，并保留用户选择的字号；用户自定义的其他字体列表保持原值。

Terminal 命令使用 Pi-Ark 服务账号的系统权限，并以 Workspace 目录作为启动目录。

## Settings

### 类别导航与全局配置

Settings 中的 Server 设置对所有 Workspace 使用同一份配置，Terminal 的字体设置保存在当前浏览器中。桌面端的左侧按类别导航，右侧显示当前类别；移动端使用可横向滚动的类别导航。移动端的顶部栏跟随当前 theme，侧栏在展开时显示阴影。类别如下：

- Interface：Appearance，包含紧凑的主题色样按钮（Ark Dark、Graphite、Midnight、Paper、Snow）、Hide reasoning 和 Keep line breaks。
- Models & providers：Provider credential 管理、write-only API key、subscription login、模型可见清单、default model 和 default thinking level。
- Agent behavior：全局 System prompt append、按需展开的 effective prompt preview、可选 replacement/append 文件路径、Steering、Follow-up、automatic compaction 和 automatic retry。
- Skills：Built-in、Global 与当前 Workspace 的 skill 列表和启用状态。
- MCP：MCP server 列表、启用开关、连接状态、诊断与浏览器运行时。
- Files：dotfile 显示和文本、Markdown 与图片的最大预览大小。
- Terminal：Server shell profile、自定义程序的绝对路径、附加参数、环境变量、浏览器字体和键盘操作说明。
- Maintenance：Pi-Ark version、bundled pi core version、install mode、release channel、latest/previous release、install/data/package paths、更新、回退，以及指向稳定 CLI 的完整 Node 调用命令（status、logs 与 restart 等）。
- Account：Sign out。

Keep line breaks（按原文换行）默认开启，会话和 Markdown 文件中的普通文本会按原文的单次换行显示。关闭后，同一段落内的普通换行合并显示，空行继续分隔段落。该设置在切换后立即保存并应用到当前页面，刷新后保留选择。

Settings 在首次访问后保留在当前页面的内存中。页面切换保留已加载的数据、所选类别、各类别的滚动位置和草稿（提示词与 Terminal shell 设置）。模型数据独立加载；effective prompt preview 在展开时加载；Skills 与 MCP 数据在首次进入对应类别时加载；Terminal shell 设置在首次进入 Terminal 类别时加载；release 信息在首次进入 Maintenance 时加载。Refresh settings 主动重新读取当前类别需要的数据；在 Terminal 类别中刷新时，页面更新 Server 配置与 profiles，同时保留尚未保存的草稿和刷新期间的新编辑内容。离开 Settings 时，页面清空尚未提交的 API key，并暂停 subscription 登录的轮询。

模型 checkbox 使用填色表示启用，使用空白状态表示关闭。切换非默认模型的启用状态时，页面保留当前的 default model 和 Default thinking level。关闭 default model 时，页面选择模型列表中第一个仍启用的模型作为新 default，并将 thinking level 调整为新 default 支持的等级。最后一个启用的模型保持启用，并显示 Select at least one model 提示。

Settings 默认在选择、切换或输入完成后立即保存，页面底部不提供统一 Save 操作。Theme 在选择时立即预览并写入服务配置；模型 checkbox、default model、default thinking level 和 Agent defaults 在选择后保存。Manage Provider 选择器用于切换当前管理的 Provider；新 Session 的 default 由模型行右侧的星标决定。API key 与 Global system prompt append 需要用户确认，因此 Save 和 Cancel 显示在各自的 section 内。Terminal 的自定义程序、附加参数和环境变量通过 Save shell settings 提交，Cancel 恢复已保存的配置；选择普通 shell profile 且其他字段保持已保存内容时，选择结果立即保存。pi 保存 API key 和 OAuth credential，浏览器接收 credential 状态与来源。使用保存 credential 的 Provider 显示 Disconnect；确认后，Pi-Ark 删除该 credential，并从仍可用的已勾选模型中保留 default，或选择第一个仍可用模型。需要安装实例标识的 subscription login 由 Server 自动生成并复用 Global device ID，页面省略该输入项。同一个 Provider 再次启动 subscription login 时，Server 会取消此前仍在等待的登录，使新的登录 flow 可以继续。

Update Pi-Ark 根据当前操作系统与 architecture 安装完整的 release artifact，其中包含经过同一版本检查的 Pi-Ark、pi-coding-agent、pi-ai 和 native dependencies。更新过程保留 Global data 与 Workspace data，并将当前 release 记录为 previous release；POSIX 切换 `current` symlink，Windows 更新 `release-state.json`。Roll back 将当前与上一 release 对调。Web 响应返回后，Server 正常关闭，后台管理器或 Linux systemd 下的 supervisor 从当前 release 重新启动并执行 health check；启动检查失败时恢复 previous release。Maintenance 从相同的 release state 显示 previous release，并提供稳定 CLI 的完整 Node 调用命令。Development checkout 和带 `dev` prerelease 的本机安装会显示 development 状态；development build 不显示 stable update 操作。

### Skills

Skills 类别按固定顺序显示三段列表：Built-in skills、Global skills 和 Workspace skills。Built-in 区域说明 skill 随 Pi-Ark release 更新；Global 区域说明 skill 在所有 Workspace 可用；Workspace 区域顶部提供 Workspace 选择器，默认使用 URL 指定的 Workspace，没有指定时使用第一个 Workspace。

每一行包含启用复选框、skill 名称、来源标记（Built-in 或 Managed）、状态（Enabled、Disabled 或 Explicit only）、description、skill 目录和 View。勾选或取消勾选后立即保存，页面显示 Saving selection；保存完成后通知 `Skill selection saved. New Sessions use the updated set.`，列表按服务端返回结果更新。保存失败时恢复服务端列表并显示错误。Built-in skill 行同样可以停用；停用记录按名称保存，release 更新后继续有效。

页面顶部显示启用 skill 数量、模型可见 description 的总字符数和估算 token；Explicit only 的 skill 不进入模型可见 description 统计。Refresh 重新扫描三段目录。扫描失败、同名 skill 冲突或 skill 文件解析失败时，Diagnostics 区域列出路径与说明。View 展开 Source、Scope、Mode 与 Location；正文通过 Terminal 打开该目录下的 SKILL.md 阅读。

`browser` 是内置 skill；`playwright` server 未启用时，该行显示 Requires playwright。

### MCP

MCP 类别使用一个列表显示所有 server，列表使用 URL 指定的 Workspace，没有指定时使用第一个 Workspace。每行包含名称、来源（Built-in 或 User）、启用开关、连接状态、Transport、Exposure、工具数量和诊断。连接状态取 Starting、Connected、Needs sign-in、Failed 或 Disabled。`playwright` 行额外显示 Recommended 标记和 Browser runtime 区域。

启用开关保存 server 的 `enabled` 字段。启用 `playwright` 时，页面先检查浏览器运行时；未安装或上次安装失败时自动开始安装 Chromium headless shell，并在 Browser runtime 区域显示 Installing 状态与目标目录，页面轮询安装状态。安装完成后保存启用状态；安装仍在进行或失败时，server 保持未启用，页面显示对应提示，失败日志显示在 `playwright` 行内。其他 server 的开关直接保存。

`playwright` 行显示 Browser runtime 状态（Not installed、Installing、Installed 或 Failed）、已安装版本与目标目录。Needs sign-in 的行显示 `pi-ark mcp login <server>` 命令提示。页面不提供添加、编辑、删除和 OAuth 登录按钮；server 定义通过 `pi-ark mcp` 命令或直接编辑 `mcp.json` 管理。配置文件解析失败或 `pi-ark mcp list --json` 返回错误时，列表上方显示 Configuration errors。

Refresh 重新执行列表读取并更新连接状态、工具数量和诊断。页面首次进入 MCP 类别时读取一次，停留在该类别期间不自动刷新。列表为空时显示 `pi-ark mcp add <name>` 提示。

### 配置的生效方式

Global system prompt append 在 pi 加载 Global prompt 资源后追加，并在新建或重新打开 Session 时进入 runtime。文件工具（`read`、`bash`、`edit` 和 `write`）在父子 Session 新建和恢复时统一启用，effective prompt preview 使用相同的文件工具。父子 Session 自带 `read_pi_ark_link`，父 Session 还自带 `subagent`，子 Session 的后续委派由父 Session 组织。Skill 启用状态或 MCP server 启用状态保存后，Server 对空闲 Session 执行 reload；正在运行的 Session 保持当前资源集合，新建 Session 使用最新集合。`playwright` 的浏览器运行时安装在服务账号 home 下的 `.cache/ms-playwright`。Files 的设置保存后立即用于所有 Workspace 的后续文件请求。Terminal 的 Server shell 设置在新建 Tab 时生效，已有 Tab 继续使用各自启动时的配置。浏览器的 Font family 和 Font size 在修改后立即应用到该浏览器已打开的 Tab，Reset font defaults 恢复默认字体列表和 13 px 的字号；字号范围为 10–30 px。

## 桌面与移动布局

桌面侧栏可以折叠，并可以通过 separator 拖动到 220 至 460 px。侧栏折叠状态、侧栏宽度、Files 文件列表宽度、Workspaces 展开状态、conversation width 和最近应用的 theme 存放在浏览器 localStorage；保存后的 Global theme 仍是服务端配置的默认值。Session draft、attachments 与 disclosure 状态使用最多五个 Session 的 memory cache，不写入 localStorage。Terminal 的字体设置和每个 Workspace 最近选择的 Tab 也保存在 localStorage，Terminal 的 xterm 界面状态保存在当前页面的内存中。

移动端使用 drawer sidebar 和顶部 mobile bar。drawer 打开时，scrim 覆盖 drawer 之外的完整应用内容，其中包括页面 header、composer 和其他浮动控件；drawer 位于 scrim 上方。点击页面入口或 Session 后，drawer 自动关闭。Composer、对话框和 Settings actions 使用适合窄屏的布局。

## 对话框与反馈

普通对话框共享紧凑的 card、header、field 和 action 样式。Delete 与 Disconnect Provider 等会删除数据的操作使用 danger 样式；Rollback 使用 neutral secondary 样式。

异步操作通过页面 status、Settings notice、dialog error 或全局错误提示反馈。Copy Markdown、Copy internal link 和 device code copy 使用短暂的 Copied 状态确认操作完成。
