# Agent Note: Adopt Agent Notes

Status: implemented

## Problem

Cooper 需要一个长期保存决策理由的地方。代码、测试和 README 能说明“做了什么”，
但说不清“为什么不是另一种做法”“放弃了什么”“什么条件下应该重新考虑”。
此前 MCP 的调研放在 `.agents/research/`，那是本地研究材料且被 git 忽略；权限模式
等设计决定则只存在于对话里。没有固定契约时，后续记录会出现格式漂移、同一决策
出现多个所有者、以及无法可靠区分“提议中 / 已实现 / 已拒绝”的问题。

`.agents/notes/` 已经预留，但在本次变更前是空目录。

## Decision

采用 DeepSeek Harness 的 Agent Notes 契约，原文保存在
[`.agents/notes/README.md`](../../README.md)。具体落地：

- 生命周期目录为 `proposed/`、`implemented/`、`rejected/`；每层只允许六个固定
  分类：`feature`、`bug-fix`、`simplification`、`architecture`、`process`、
  `testing`。
- 每条 Note 的路径是 `{lifecycle}/{class}/yyyy-mm-dd-topic-title.md`；正文语言
  可以用中文，但 `# Agent Note:`、`Status:` 和规范章节标题保持英文原文。
- `archived/` 只存放已实现的冻结记录，并有追加式 `manifest.json` 哈希封印；
  归档内容不得编辑、移动、翻译或删除。
- 当前没有翻译对侧文件，也没有自动检查脚本；机械检查暂为人工执行，规则以
  `README.md` 为准。等仓库有了文档检查入口，再把结构、格式、链接、归档封印
  接入检查。
- `.agents/research/` 继续作为本地调研目录（被 `.agents/research/.gitignore`
  忽略），不承担决策记录职责；需要长期保留的理由应迁入 Notes。
- 采纳本身记录为本条 `process` Note。

## Alternatives considered

- **继续把决定放在 `.agents/research/`**：研究目录被 git 忽略，无法随代码分发；
  没有生命周期、分类、交叉链接和归档封印，决策会被覆盖或丢失。
- **写自由格式的 Markdown 笔记**：没有固定头部和目录结构，无法可靠判断一条
  记录是提议、已实现还是已拒绝，也无法机械检查重复所有权。
- **使用单一 ADR 文件**：所有决策挤在一个文件里，失去生命周期和分类，交叉链接
  失效，且所有修改争用同一个文件。
- **只依赖 issue tracker 或对话历史**：不随仓库版本化，离线不可读，未来维护者
  无法在代码旁边看到理由。

## Consequences

- 以后每个重要的、非机械的决策都需要一条 Note；这是有意的过程成本。
- 在自动检查落地前，结构和格式由人工审查保证；这比没有契约更容易发现漂移。
- 归档是不可逆的：要改变一个已归档决定，必须写新 Note 并交叉链接，不能改写历史。
- 研究材料仍然本地化；只有经过整理的决策理由进入版本库。
- 采用这套结构来自 DeepSeek Harness 的 Agent Notes 系统，但分类、模板和检查
  完全以本仓库的 `README.md` 为准。
