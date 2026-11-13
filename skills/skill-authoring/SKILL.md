---
name: skill-authoring
description: 创建、修改或安装 Agent Skill 到 Pi-Ark 管理的目录。适用于用户要求新增 skill、把已有目录或仓库里的 skill 装到 Pi-Ark、或调整 skill 的触发描述。
---

# Skill 创建与安装

## 安装位置

新的 skill 写入 Pi-Ark 管理的目录。

- 全局：`$PI_ARK_AGENT_DIR/skills/<name>/SKILL.md`，所有工作区可用。
- 工作区：`<workspace>/.pi-ark/skills/<name>/SKILL.md`，只在当前工作区可用。

`$PI_ARK_AGENT_DIR` 是当前实例的 agent 目录，工作区路径取当前会话的工作目录。

Pi-Ark 还会读取以下位置，这些位置属于项目自身配置，用于复用已有 skill。

- `<workspace>/.pi/skills/`
- `<workspace>/.agents/skills/`，并沿父目录向上读到仓库根目录
- `~/.agents/skills/`

## 创建步骤

1. 在目标目录下建 `<name>` 文件夹，写入 `SKILL.md`。目录名与 frontmatter 的 `name` 保持一致，使用小写字母、数字与连字符，长度不超过 64 个字符。
2. frontmatter 写 `name` 与 `description`。`description` 说明这个 skill 做什么、什么时候使用，写清触发关键词，长度不超过 1024 个字符。
3. 需要脚本、模板或参考资料时，在 skill 目录下建 `scripts/`、`assets/`、`references/`，正文用相对路径引用。
4. 正文写步骤、输入输出示例与常见情况。

## 安装已有 skill

用户给出仓库或本地目录时，复制整个 skill 目录到目标位置，保持 `SKILL.md` 与附带文件的结构。只改动与当前工作区相关的路径与命令。

## 验证

1. 打开 Settings 的 Skills 页，点 Refresh，确认新 skill 出现在对应分组，来源与路径正确。
2. 名称冲突时列表会给出诊断，改名后重试。
3. 新开一个 Session，确认模型能看到该 skill 的 name 与 description。
