---
name: pdf
description: 读取 PDF 文件的内容。用 poppler 抽取每页文字，再把需要看版式的页面渲染成图片一起阅读，两路结果合并成完整理解。适用于用户给出 PDF 路径或上传 PDF、要求总结内容、核对数字、读取财报论文合同与扫描件、或需要按页码引用原文的场景。
---

# PDF 阅读

主流 AI agent 读取 PDF 时同时使用两条输入通道。文字通道抽取每页文本层，便于通读全文与定位页码。图片通道把页面渲染成图片，补回表格行列、图表、公式和扫描页里没有文本层的内容。两条通道的结果都进入上下文，一起构成对文档的理解。

文字通道单独使用时，会丢失几类信息（扫描页没有文字、表格的行列关系被打乱、多栏正文的阅读顺序混乱、图表内的数据缺失、页眉页脚混入正文）。图片通道补回这些内容。

## 前置条件

- poppler 的四个命令：`pdfinfo`、`pdftotext`、`pdfimages`、`pdftoppm`。
- 辅助脚本 `scripts/pdf.mjs` 用 Node 运行，Pi-Ark 自带 Node 运行时。
- 脚本位置是本 skill 目录下的 `scripts/pdf.mjs`。系统提示的 `<location>` 给出 `SKILL.md` 的绝对路径，去掉末尾的 `SKILL.md` 就是 skill 目录。

检查依赖：

```bash
command -v pdfinfo pdftotext pdfimages pdftoppm
```

缺少命令时先安装 poppler：Debian 与 Ubuntu 用 `apt-get install -y poppler-utils`，Fedora 与 RHEL 用 `dnf install poppler-utils`，macOS 用 `brew install poppler`，Windows 用 `scoop install poppler`（或 `conda install -c conda-forge poppler`）。脚本检测到缺少命令时以 `缺少命令` 开头报错，并按当前平台给出一条安装命令。

## 读取流程

### 第 1 步：分诊

```bash
node <skill-dir>/scripts/pdf.mjs probe <file.pdf>
```

probe 一次读取页数、页面尺寸、文字层总字符数，以及每页的文字量、表格状行数和大图数量。输出示例：

```
file: /workspace/reports/2025.pdf
pages: 179
page-size: 595.2 x 842.04 pts (A4)
encrypted: no
chars: 181708 total in the text layer
summary: text-only 70 | render-recommended 108 | render-required 1
render-required: 83
render-recommended: 1, 5-8, 10, 12-14, 21, 23, 25-37
```

文档不超过 40 页时，probe 另外打印每页明细表：

```
page  chars  lines  rows  images  hint
   1    602     26     1       0  text-only
   2      0      0     0       1  render-required
  12   1840     54    22       0  render-recommended
```

`hint` 是脚本按页面特征给出的通道建议，模型结合用户的问题决定实际读取范围。

| hint | 含义 | 处理 |
|---|---|---|
| `text-only` | 文字层足够，没有大图，也没有表格状排版 | 只读文字通道 |
| `render-recommended` | 页面有大图，或存在 5 行以上的表格状排版 | 读文字通道后，渲染这一页的图片核对表格与图表 |
| `render-required` | 文字层的非空白字符不足 50 个 | 这一页的内容在图片里，必须渲染后阅读 |

### 第 2 步：读文字通道

```bash
node <skill-dir>/scripts/pdf.mjs text <file.pdf> --out .tmp/pdf/<name>/text.md
```

- 加 `--out` 时脚本把全文写进文件，只打印路径与字符数，再用 read 工具配合 `offset` 与 `limit` 分段读取。文档较长时用这种方式，避免 bash 输出被截断。
- 不加 `--out` 时脚本把文字打印到标准输出，适合几页以内的短文档。
- 表格页用 `--layout` 保留原始横向排版，列与列之间的间距留在输出里，读起来接近原表。
- 多栏正文用默认模式，按阅读顺序输出。
- 用 `--pages` 只取需要的页，例如 `--pages 1-5,8`。页范围支持 `3`、`1-5`、`2-4,9,12-` 这几种写法。

### 第 3 步：渲染页面图片

```bash
node <skill-dir>/scripts/pdf.mjs pages <file.pdf> --pages 2,7-9
```

- 默认 150 DPI、JPEG 质量 85。A4 页面在这个分辨率下是 1240x1754 像素，read 工具按原尺寸发送。
- poppler 0.58.0 之前的版本没有 `-jpegopt`。脚本遇到拒绝该参数的输出时去掉它重试一次，渲染仍然完成，输出行标注 `poppler default quality`。
- 默认输出目录是 `.tmp/pdf/<文件名>-<DPI>dpi/`，每个页面生成一个 `page-001.jpg`，脚本逐行打印生成的文件路径。
- 表格小字看不清时用 `--dpi 200`。超过 2000 像素的图片会被 read 工具缩小。
- 需要无损输出时用 `--format png`，文件体积明显大于 JPEG。
- 整份文档都要图片时用 `--all`，先确认页数。

### 第 4 步：读图片并合并

用 read 工具逐张读取脚本打印的路径，图片会作为附件进入上下文。一次读 8 到 10 张，按页面承载的信息量排序，先读结论页、图表页和表格页。

合并两路结果时遵守以下规则：

- 表格里的数字以页面图片为准。文字层在同一行里打乱列顺序时，按图片重新对齐。
- 扫描页的全部内容来自图片通道，引用时说明内容读自页面图片。
- 图表里的趋势、图例、坐标轴数值只能在图片通道得到，文字层没有这些信息。
- 页眉、页脚、页码从文字层里剔除，避免混进正文。
- 结论里给出页码，方便用户回查。

## 按任务选取读取范围

| 任务 | 读取范围 |
|---|---|
| 总结整份文档 | 先读全文文字通道，再渲染结论页、图表页、表格页 |
| 核对某个数字或条款 | 先用 `text --pages` 定位页，再渲染该页图片核对 |
| 读取扫描件 | 全部页面都是 `render-required`，逐页渲染后阅读 |
| 读取表格数据 | `text --pages <n> --layout` 拿行列，再渲染该页图片核对数字与小字 |
| 对比多份文档 | 每份先 probe，再按同一套页范围读取，避免遗漏同类页面 |

每页图片消耗与一张普通图片相当的 visual tokens。整份渲染长文档开销大，先看文字通道判断哪些页承载关键信息，再渲染这些页。

## 命令参考

| 命令 | 关键参数 | 输出 |
|---|---|---|
| `probe` | 无 | 页数、页面尺寸、文字层字符数、逐页明细与通道建议 |
| `text` | `--pages`、`--layout`、`--out` | 带 `===== Page N =====` 标记的页文本 |
| `pages` | `--pages` 或 `--all`、`--dpi`、`--format`、`--out` | 每个页面的图片路径与文件大小 |

三个子命令都接受 `--help`。

## 用户上传的 PDF

用户从输入框上传的 PDF 保存在当前工作区的 `.pi-ark/attachments/<session-id>/` 目录下。发送内容时会附上文件的绝对路径，直接把这个路径交给脚本。

## 常见情况

- 命令以 `缺少命令` 开头：poppler 没有安装。按报错给出的命令安装后重试。
- 命令以 `执行失败` 开头：poppler 拒绝处理这个文件。先读报错的原始信息。加密文件向用户索取解密后的版本。
- `pages` 报页范围超出文档范围：以 probe 输出的总页数为准，修正 `--pages`。
- read 返回 `[Current model does not support images. The image will be omitted from this request.]`：当前模型不接受图片输入。此时使用文字通道的结果，并向用户说明图片通道不可用。
- 页面渲染为空白：检查 `--pages` 的页码与 probe 的页数是否一致，再确认这一页是否本来就没有内容。
- `text` 写出的文件很大：用 read 的 `offset` 与 `limit` 分段读取，或者用 `--pages` 缩小范围。
