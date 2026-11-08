# Cooper

一个 Coding Agent，早期阶段以 TUI 为主要形式（后续可能扩展 desktop / server 等其他形态）。当前处于**阶段 1**：完整编码闭环——读写文件、执行命令、审批控制。

## 目录结构

```
packages/core/
  src/types.ts                       消息 / 工具调用类型
  src/provider/types.ts              Provider 流式接口（与厂商无关）
  src/provider/openai-compatible.ts  OpenAI 兼容协议实现
  src/agent.ts                       Agent loop + 审批钩子（无 UI 依赖）
  src/permissions.ts                 权限预设、工具能力与 fail-closed 决策
  src/tools/tool.ts                  工具接口 + zod → JSON Schema
  src/tools/paths.ts                 工作区路径逃逸防护
  src/tools/fs.ts                    list_dir / read_file / grep / write_file / edit_file
  src/tools/shell.ts                 run_command
  src/diff.ts                        行级 diff（供审批预览）
  src/context/estimator.ts           token 估算（CJK 感知）+ 真实 usage 校准
  src/context/groups.ts              消息分组与安全压缩边界
  src/context/prune.ts               L1：旧工具输出剪枝
  src/context/summarize.ts           L2：分块摘要
  src/context/budget.ts              阈值决策与编排
  src/context/window.ts              模型窗口表
  src/instructions.ts                COOPER.md / AGENTS.md 加载
  src/session.ts                     会话持久化（JSONL、checkpoint、恢复）
apps/cli/
  src/index.tsx                      入口：解析参数、切换 TUI / 无头
  src/args.ts                        命令行参数解析（纯函数，可单测）
  src/app.tsx                        Ink + React TUI + 审批面板
  src/headless.ts                    无头单次运行（stdout=回复，stderr=工具活动）
  src/preview.ts                     审批面板的 diff 行构造
  src/session-view.ts                恢复会话时重建滚动区
  src/system-prompt.ts               系统提示（两种界面共用）
  src/stream-lines.ts                流式文本按行切分
  src/config.ts                      .env 配置读取
```

## 快速开始

要求 Node.js 20+（当前在 Node 26 上验证）。

```bash
npm install
cp .env.example .env        # Windows PowerShell: Copy-Item .env.example .env
# 编辑 .env，至少填 COOPER_API_KEY
npm run dev
```

`COOPER_BASE_URL` 支持任何 OpenAI 兼容端点，例如：

| 供应商 | COOPER_BASE_URL | COOPER_MODEL |
|---|---|---|
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| DeepSeek | `https://api.deepseek.com` | `deepseek-chat` |
| Moonshot | `https://api.moonshot.cn/v1` | `kimi-k2-0711-preview` |

## 运行方式

### 交互式 TUI

```bash
npm run dev
```

### 无头模式（单次问答）

```bash
npm run dev -- -p "这个项目是做什么的"
npm run dev -- "这个项目是做什么的"          # 位置参数等价
npm run dev -- --mode auto -p "修一下测试"
cat task.md | npm run dev -- -p -            # 从 stdin 读 prompt

# 重定向时用 --silent，否则 npm 会在 stdout 前面打印两行命令 banner
npm run --silent dev -- -p "..." > answer.md
```

- **stdout 只有模型的文字回复**（加 `--silent` 时），可以直接重定向
- **stderr** 是工具活动（`→ write_file …` / `✓ 12ms`）、警告与错误
- 退出码：`0` 成功，`1` 失败或达到最大轮数，`130` 被中断

无头模式下没有人能点审批，所以一律 **fail-closed**：

| 模式 | 无头行为 |
|---|---|
| `ask`（默认） | 读写类工具直接拒绝，模型预先被告知不要重试 |
| `auto` | 自动放行 |
| `plan` | 拒绝所有修改 |

要让它真的改文件，必须显式 `--mode auto`。

### 指定工作目录

```bash
npm run dev -- --cwd ../my-app
npm run dev -- -C ../my-app -p "跑一下测试"
```

工作目录同时决定：工具能访问的根、`run_command` 的执行目录、`.env` 的查找起点。

`.env` 查找顺序（先命中者生效；真实环境变量永远优先于任何文件）：

1. `<工作目录>/.env`
2. `<工作目录>/../../.env`（兼容 monorepo）
3. Cooper 自己的 `.env`（所以换项目时不必复制密钥）

## 会话持久化

TUI 和 `-p` 默认都会把对话写到磁盘，退出后可以接着聊：

```bash
npm run dev -- --sessions           # 列出当前工作区的会话
npm run dev -- --resume <id>        # 继续某个会话
npm run dev -- -p --resume <id> "接着改"
npm run dev -- --no-session         # 本次不落盘
```

- 存储位置：`~/.cooper/projects/<工作区标识>/sessions/<id>.jsonl`。工作区标识由路径生成，同一工作区共享；`COOPER_HOME` 可以换根目录。
- 每个会话是一个 **JSONL 追加文件**，崩溃时最多丢最后一行。恢复时会忽略损坏的行，并丢弃缺少工具结果的残缺尾部（否则下一次请求会被 API 拒绝）。
- TUI 横幅和无头模式的 stderr 都会打印会话 id。
- 会话绑定工作目录：在别的工作区 `--resume` 会报错，不会把路径错配到另一个项目。
- 上下文压缩后会追加一条 **checkpoint**（压缩后的消息快照）。恢复时以最后一个 checkpoint 为基底再回放后续消息，既保持与退出时一致的上下文，也避免恢复时再花一次摘要调用。
- **推理内容不落盘**（规则 15）。**“本次会话始终允许”也不落盘**：重启后权限重新询问，不会因为旧会话静默放行工具。
- system 提示不落盘，恢复时按当前模式、指令和工作目录重新生成。切换项目指令或权限模式后继续旧会话是安全的。
- 无头模式仍然保持 stdout 只有答案；会话 id、恢复提示和“未保存”告警都走 stderr。

## 项目指令

启动时自动加载两类指令并注入系统提示：

1. `~/.cooper/AGENTS.md`（或 `COOPER.md`）—— 个人偏好，对所有项目生效
2. `<工作目录>/COOPER.md`（或 `AGENTS.md`）—— 项目约定

每个目录只取一个文件，`COOPER.md` 优先于 `AGENTS.md`。个人偏好在前、项目约定在后，冲突时后者更具体。总长度截断在 32k 字符以内，避免一个巨大的指令文件吃掉上下文预算。

指令只影响"怎么做"，不能改变权限规则：系统提示里权限段在指令之前，并明确要求指令不得与之冲突。TUI 启动横幅会显示 `Instructions: AGENTS.md`，无头模式则在 stderr 打印一行。

## 审批模式

| 模式 | 行为 |
|---|---|
| `ask`（默认） | 读操作直接执行；写文件、改文件、执行命令前弹窗确认 |
| `auto` | 所有工具自动放行（谨慎使用） |
| `plan` | 只读：允许读取，拒绝一切写入和命令执行 |

```bash
npm run dev                  # ask
npm run dev -- --mode plan   # 只读规划
COOPER_MODE=auto npm run dev # 也可用环境变量
```

权限决策由 `packages/core/src/permissions.ts` 统一执行，宿主只负责界面：

- 每个工具声明 `capabilities`：`read` / `write` / `execute`。含写或执行能力的工具进入审批流程；缺少声明按最高风险处理。
- 预设决定默认决策：`plan` 直接拒绝；`ask` 在交互界面询问、在无头模式拒绝；`auto` 放行。
- 审批结果有三种：`allow`（本次）、`allow-session`（本进程内该工具不再询问，不落盘）、`deny`。
- 核心层 **fail-closed**：策略要求询问但没有 `approve` 回调时，工具不会执行。plan 模式根本不调用审批回调，宿主无法把它降级成 `ask`。
- 系统提示的权限段由同一个策略实例生成，界面和执行不会各写一套。

`write_file` / `edit_file` 的审批面板会显示**真实 diff**：带 3 行上下文，`+` 绿色、`-` 红色，最多 18 行，超出部分折叠成计数。工具通过可选的 `preview()` 提供 `before` / `after`，diff 在宿主侧计算，所以未来的 desktop / server 界面可以换一种渲染方式。

审批面板按键：

- `y` 本次允许
- `a` 本次会话内始终允许该工具
- `n` / `Esc` 拒绝（模型会收到拒绝结果并继续解释）

## 推理内容

支持 `reasoning_content` / `reasoning` 字段的端点（DeepSeek、Kimi、Qwen、OpenRouter 等）会额外返回模型的推理摘要。

- **默认**：不显示文本，只在运行时显示 `reasoning 12.3k chars` 的进度提示；端点报告推理 token 数时，每轮结束留一行 `· reasoned 1.2k tokens`
- **`--show-reasoning`**（或 `COOPER_SHOW_REASONING=1`）：按完整行以暗灰色提交到滚动区；无头模式写到 stderr，stdout 仍然只有答案

**推理内容永远不进入对话历史**，也不会被将来的会话持久化保存。三个原因：DeepSeek 明确要求 `reasoning_content` 不能回传；回传只会白白消耗上下文；推理摘要未必忠实反映模型的实际计算，让它变成后续轮次的上下文会污染判断。

不是所有端点都返回推理文本——OpenAI 的推理模型通过 chat completions 只给 token 计数，Anthropic 返回的是摘要。所以这是"有就显示、没有就沉默"的能力，不能当成核心功能依赖。

## 上下文管理

长会话不会撞上下文上限：每次请求前估算 token 数，超阈值就按"最便宜的先做"分三层处理。

| 层级 | 触发 | 动作 | 成本 |
|---|---|---|---|
| L1 剪枝 | 可用预算的 65% | 旧工具输出换成存根，保留最近 8 条原文 | 本地，无模型调用 |
| L2 摘要 | 80% | 把较早的对话总结成一条消息，压到 45% | 一次模型调用 |
| L3 截断 | 92% | 丢弃最旧的完整消息组 | 本地，必定成功 |

"可用预算" = 窗口 − 预留输出（默认 16384）。剪枝放第一位，因为工具输出是最大的浪费源；摘要压到 45% 而不是刚好过线，避免下一轮马上又触发。任何一层都不会把 `assistant.tool_calls` 和对应的 `tool` 结果拆开。

**窗口大小**按模型名查表（Claude / GPT / Gemini / DeepSeek / Kimi / Qwen / GLM 等），识别不了时假设 **200k**，与 Claude Code 对未知模型的处理一致。TUI 启动横幅会标明这个值是不是假设的。猜大了不会致命：如果 API 以 `context length` 之类的错误拒绝请求，Cooper 会压到上次请求大小的一半再重试一次。

**token 估算**不依赖 tokenizer：CJK 按约 1.1 token/字符、其余按 3.6 字符/token，再加上消息结构开销和工具 schema。端点返回 `usage` 时用真实值做指数滑动平均修正；不支持的端点会自动降级（`stream_options` 被拒后重试一次并记住）。

| 变量 | 默认 | 说明 |
|---|---|---|
| `COOPER_CONTEXT_WINDOW` | 按模型表，否则 200000 | 窗口大小 |
| `COOPER_CONTEXT_RESERVE` | 16384 | 预留给回复的 token |
| `COOPER_CONTEXT_COMPACT` | `on` | `off` 时只发送、不压缩 |
| `COOPER_SUMMARY_MODEL` | 同主模型 | 摘要用更便宜的模型 |

压缩发生时界面会显示 `⤓ context 92.4k → 18.1k tokens (summarize)`。摘要用英文生成：同样的信息量，中文的成本约为英文的三倍。

## 可用工具

只读：

- `list_dir` — 列目录，自动跳过 `node_modules`、`.git`、`dist` 等
- `read_file` — 按行号读取，支持 `offset` / `limit`
- `grep` — 正则搜索文件内容，支持 `include` glob

需要审批：

- `write_file` — 创建或覆盖文件，自动创建父目录
- `edit_file` — 精确字符串替换；默认要求唯一匹配，可设 `replace_all`
- `run_command` — 在工作区内执行 shell 命令，默认超时 120s，输出上限 30k 字符

所有工具都被限制在启动目录内，路径逃逸会被拒绝。

## 命令

```bash
npm run dev                                # 启动 TUI（从仓库根目录运行）
npm run dev -- -p "..." [--mode auto]      # 无头单次运行
npm run dev -- --cwd ../other-project      # 在别的工作区启动
npm run dev -- --sessions                  # 列出本工作区保存的会话
npm run dev -- --resume <id>               # 继续某个会话
npm run dev -- --no-session                # 本次不保存会话
npm run typecheck                          # 全仓库类型检查
npm test                                   # core + cli 单元测试
```

## 架构约定

1. `packages/core` 不依赖 Ink/React，也不直接写 stdout。它只产出 `AgentEvent`。
2. 每种界面（TUI / 未来的 desktop、server）都是事件的消费者。
3. 工具统一实现 `Tool` 接口，输入用 zod 定义，自动转成 JSON Schema 交给模型。
4. 每个工具声明 `capabilities`；写/执行能力由 `PermissionPolicy` 审批，缺失声明按危险处理，核心层 fail-closed。
5. 流式输出按完整行提交给 `<Static>`，live 区只保留未完成的一行。
6. Provider 统一实现 `Provider` 接口，厂商差异只存在于适配器内部。
7. 系统提示由 `apps/cli/src/system-prompt.ts` 统一生成，权限段从 `PermissionPolicy` 实例派生，TUI 与无头模式共用。项目指令由 `packages/core/src/instructions.ts` 读取，只追加在权限段之后。

## 下一步

- Anthropic 原生适配器、MCP 客户端
- 自动格式化 / linter 集成，测试失败自动回灌
