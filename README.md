# Cooper

一个 Coding Agent，早期阶段以 TUI 为主要形式（后续可能扩展 desktop / server 等其他形态）。当前处于**阶段 1**：完整编码闭环——读写文件、执行命令、审批控制。

## 目录结构

```
packages/core/
  src/types.ts                       消息 / 工具调用类型
  src/provider/types.ts              Provider 流式接口（与厂商无关）
  src/provider/openai-compatible.ts  OpenAI 兼容协议实现
  src/provider/anthropic.ts          Anthropic Messages API 实现
  src/agent.ts                       Agent loop + 审批钩子（无 UI 依赖）
  src/permissions.ts                 权限预设、工具能力与 fail-closed 决策
  src/runtime-notice.ts              权限模式的 runtime notice
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
  src/home.ts                        ~/.cooper 常量锚点（不可被环境变量改写）
  src/mcp/config.ts                  MCP 配置与信任规则
  src/mcp/client.ts                  MCP 连接、工具列表、生命周期
  src/mcp/resources.ts               MCP resources 的共享工具与结果投影
  src/mcp/tool.ts                    MCP tool → Tool 适配
apps/cli/
  src/index.tsx                      入口：解析参数、切换 TUI / 无头
  src/args.ts                        命令行参数解析（纯函数，可单测）
  src/commands.ts                    TUI slash 命令解析（纯函数，可单测）
  src/app.tsx                        Ink + React TUI
  src/approval.tsx                   工具审批面板和键盘交互
  src/headless.ts                    无头单次运行（stdout=回复，stderr=工具活动）
  src/preview.ts                     审批面板的 diff 行构造
  src/session-view.ts                恢复会话时重建滚动区
  src/system-prompt.ts               系统提示（两种界面共用）
  src/stream-lines.ts                流式文本按行切分
  src/provider.ts                    根据配置构造 Provider
  src/mcp.ts                         加载可信 MCP 配置并组装工具
  src/config.ts                      配置聚合（flag > env > config.json > 默认）
  src/settings.ts                    ~/.cooper/config.json 加载校验
  src/onboarding.tsx                 首次运行引导（缺 key 时的向导）
```

## 快速开始

要求 Node.js 22.12.0 或更高版本。

```bash
npm install
npm run dev          # 首次运行会进入引导：选协议 → 填 key → 验证并保存
```

引导把结果写进 `~/.cooper/config.json`，之后所有项目共用。CI 和脚本在启动前准备好同一个配置文件，填齐 `protocol`、`model`、`baseURL` 和 `apiKey`。

填写模型后可指定总上下文窗口。已有 `context.window` 会预填，回车可保留。没有配置时可留空，Cooper 会使用模型表中的窗口，未知模型暂按 200,000 token 估算。手动填写的窗口会写入 `context.window`。

引导用模型列表请求检查端点。失败后可按 `e` 返回修改连接参数，或按 `k` 单独修改密钥。所选模型在首轮对话时验证。保存时先完整写入同目录临时文件，再替换配置。POSIX 上新文件以 `0600` 创建，Windows 的访问权限由文件系统 ACL 决定。

协议**显式**选择（不按模型名猜测，因为 Claude 也可能通过 OpenAI 兼容网关提供）。**`protocol`、`model`、`baseURL`、API key 四项都必须显式配置**，缺任何一项启动即报错（交互式进引导补齐，无头 fail closed）；官方端点只作为引导里的 **placeholder**，回车确认后写入，`loadConfig` 绝不静默代填。

| 协议（`protocol`） | 端点（placeholder / 必填） | 模型 |
|---|---|---|
| `openai-chat` | `https://api.openai.com/v1`（引导 placeholder） | **必填**（无默认） |
| `openai-responses` | `https://api.openai.com/v1`（引导 placeholder） | **必填**（无默认） |
| `anthropic-messages` | `https://api.anthropic.com`（引导 placeholder） | **必填**（无默认） |

OpenAI 兼容端点通过 `baseURL` 指定，例如：

| 供应商 | `baseURL` | `model` |
|---|---|---|
| OpenAI | `https://api.openai.com/v1` | `gpt-6-astra` |
| DeepSeek | `https://api.deepseek.com` | `deepseek-flash` |
| Moonshot | `https://api.moonshot.cn/v1` | `kimi-k3.1-pro` |

DeepSeek 的 Chat Completions 在思考模式下要求带 `tools` 的请求回传历史 `reasoning_content`。适配器会把该字段保存在 assistant 消息的 `continuation` 中，并在同一个 endpoint/model 下原样回传；缺少它时端点会返回 HTTP 400。参见 [DeepSeek 思考模式文档](https://api-docs.deepseek.com/guides/thinking_mode/#tool-calls)。

`anthropic-messages` 将 `maxOutputTokens`（默认 64000）作为 `max_tokens` 发送。对支持 adaptive thinking 的 Claude 模型，适配器会请求摘要式 thinking，`--show-reasoning` 因此可用；旧模型自动省略该参数。

使用 `openai-responses` 时，`baseURL` 填 API 根路径，由 SDK 添加 `/responses`。显式配置 `maxOutputTokens` 时发送 `max_output_tokens`，省略时使用服务端默认值。`--show-reasoning` 会请求模型提供推理摘要。若端点拒绝摘要参数，Cooper 会省略该参数重试一次。

## 配置

TUI 和 headless 都从 **`~/.cooper/config.json`** 读取 provider 配置。旧版的环境变量、`env` 对象、`--env-file` 和 `--model` 已移除。工作区的 `.env` 和 provider 配置文件不会被加载。

在 TUI 空闲时输入 `/config`，用 ↑/↓ 浏览字段，按 Enter 编辑，再按 Enter 暂存该字段。回到字段浏览时按 Ctrl+S 保存到 `~/.cooper/config.json` 并立即应用，或按 Esc 放弃草稿。可以用 `/config model` 或 `/config apiKey` 直接跳到指定字段，API 密钥输入有遮罩。

下一轮会沿用当前会话历史，并使用新的模型连接、上下文设置、推理显示和命令 shell。切换端点后，会话历史会随下一轮请求发送到新端点。校验或保存失败时，Cooper 会继续使用上一份配置。用其他工具编辑文件后，可以执行 `/reload` 应用。

`/status` 显示生效值和来源，密钥只显示是否已设置。`mode` 是启动默认值，当前模式可用 `/plan`、`/ask` 或 `/auto` 切换。启动参数 `--show-reasoning` 仍优先。

配置文件示例（JSON，严格校验；未知字段告警并忽略，JSON 损坏直接报错）：

```json
{
  "protocol": "openai-chat",
  "model": "gpt-4o-mini",
  "baseURL": "https://gateway.example/v1",
  "apiKey": "sk-…",
  "maxOutputTokens": 64000,
  "showReasoning": false,
  "mode": "ask",
  "context": {
    "window": 200000,
    "reserveOutputTokens": 16384,
    "compact": true
  }
}
```

规则：

- **迁移旧配置**：把旧 `env` 对象里的 `COOPER_BASE_URL` 和 `COOPER_API_KEY` 移到顶层 `baseURL` 和 `apiKey`，再删除 `env` 对象。原本通过 shell 或启动参数配置的连接信息也需要写入该文件。
- 权限模式优先级为 `--mode` > 会话保存的 `plan` / `ask` > 配置文件的 `mode` > `ask`。`COOPER_MODE` 已移除。配置默认值只支持 `plan` 和 `ask`，旧的 `"mode": "auto"` 会被忽略并提示迁移。
- **`COOPER_HOME` 已移除**：数据目录固定为 `~/.cooper`。曾设置过该变量的用户会被忽略（pre-1.0 破坏性变更）。

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

工作目录决定内置文件工具的根、`run_command` 的启动目录、MCP 项目配置（需 `--mcp-project`）与会话归属。凭据和偏好从 `~/.cooper/config.json` 读取。


## 会话持久化

TUI 和 `-p` 默认都会把对话写到磁盘，退出后可以接着聊：

```bash
npm run dev -- --sessions           # 列出当前工作区的会话
npm run dev -- --resume <id>        # 继续某个会话
npm run dev -- -p --resume <id> "接着改"
npm run dev -- --no-session         # 本次不落盘
```

- 存储位置：`~/.cooper/projects/<工作区标识>/sessions/<id>.jsonl`。工作区标识由路径生成，同一工作区共享；`~/.cooper` 是固定常量，不可改写。
- 每个会话是一个 **JSONL 追加文件**，崩溃时最多丢最后一行。恢复时会忽略损坏的行，并丢弃缺少工具结果的残缺尾部（否则下一次请求会被 API 拒绝）。
- TUI 横幅和无头模式的 stderr 都会打印会话 id。
- 会话绑定工作目录：在别的工作区 `--resume` 会报错，不会把路径错配到另一个项目。
- 上下文压缩后会追加一条 **checkpoint**（压缩后的消息快照）。恢复时以最后一个 checkpoint 为基底再回放后续消息，既保持与退出时一致的上下文，也避免恢复时再花一次摘要调用。
- 推理展示事件只在运行期间使用，不落盘。适配器把端点要求续传的 payload（`reasoning_content`、完整 assistant `content` 等）保存在 `Message.continuation` 中，随消息持久化，恢复视图会过滤它。**“本次会话始终允许”也不落盘**：重启后权限重新询问，不会因为旧会话静默放行工具。
- system 提示不落盘，恢复时按工作目录和项目指令重新生成；它不包含当前模式，保持字节稳定以复用 provider 的 prompt cache。
- 当前模式作为 `policy` 记录追加到会话；模型看到的模式说明是带 `runtime: "permission-mode"` 的 `<cooper-runtime>` 消息，TUI 和恢复视图会过滤它，不把它显示成用户输入。
- 启动时用 `--resume` 恢复会话，可以沿用保存的 `plan` 或 `ask`。保存的 `auto` 会被跳过，继续使用配置默认值或 `ask`。开启 `auto` 需要本次启动传入 `--mode auto`，或在空闲的 TUI 内输入 `/auto`。
- 无头模式仍然保持 stdout 只有答案；会话 id、恢复提示和“未保存”告警都走 stderr。

## 项目指令

启动时自动加载两类指令并注入系统提示：

1. `~/.cooper/AGENTS.md`（或 `COOPER.md`）—— 个人偏好，对所有项目生效
2. `<工作目录>/COOPER.md`（或 `AGENTS.md`）—— 项目约定

每个目录只取一个文件，`COOPER.md` 优先于 `AGENTS.md`。个人偏好在前、项目约定在后，冲突时后者更具体。总长度截断在 32k 字符以内，避免一个巨大的指令文件吃掉上下文预算。

项目指令约定工作方式。系统提示先写权限规则，再写项目指令，并要求项目指令遵守权限规则。TUI 的 `/status` 会列出已加载的指令文件，无头模式会在 stderr 显示这一信息。

## 审批模式

| 模式 | 行为 |
|---|---|
| `ask`（默认） | 读操作直接执行；写文件、改文件、执行命令前弹窗确认 |
| `auto` | 所有工具自动放行（谨慎使用） |
| `plan` | 只读：允许读取，拒绝一切写入和命令执行 |

```bash
npm run dev                  # ask
npm run dev -- --mode plan   # 只读规划
npm run dev -- --mode auto  # 显式开启本进程的自动审批
```

TUI 空闲时可以直接切换：

| 命令 | 作用 |
|---|---|
| `/plan` | 只读规划模式 |
| `/ask` | 写/命令逐次审批 |
| `/auto` | 所有工具自动放行（会显示 warning） |
| `/help` | 列出命令和当前模式 |

其他基础命令（同样只在空闲时可用）：

| 命令 | 别名 | 作用 |
|---|---|---|
| `/clear` | `/new`、`/reset` | 开启空上下文的新对话；旧会话文件保留，可用 `--sessions` 找回 |
| `/compact` | — | 上下文超过摘要阈值时手动压缩，否则提示无需压缩 |
| `/sessions` | — | 列出本工作区已保存的会话 |
| `/resume <id>` | — | 切换到已保存会话（支持唯一 id 前缀）；保持当前权限模式 |
| `/mcp` | — | 显示 MCP 服务器连接状态与工具数 |
| `/tools` | — | 列出工具及其 `read`/`write`/`execute` 能力 |
| `/status` | — | 显示工作区、指令文件、会话、上下文占用率和生效配置 |
| `/config [setting]` | — | 在 TUI 内编辑、保存并应用用户配置 |
| `/reload` | — | 重新读取用户配置，应用于后续对话 |
| `/exit` | — | 退出 TUI |

输入以 `/` 开头时，输入框上方会浮出注册表候选（前缀匹配，含别名）：

- `↑` / `↓` 移动高亮，`Tab` 补全为规范命令名（保留已输入的参数），`Enter` 直接执行高亮项
- `Esc` 收起浮层但保留已输入文本（再按一次且轮次进行中才会中断）
- 单独输入 `/` 列出全部命令；无匹配时不显示浮层，`Enter` 按未知命令提示

- 命令不发给模型，也不写 message 记录；模式变化只追加 `policy` 记录和一条 runtime notice。
- 当前轮次进行中（包括等待审批）不能执行命令，等轮次结束或按 `Esc`。
- 切换是 **cache-first** 的：不改系统提示、不改更早的消息，只在对话尾部追加模式通知；provider 的旧前缀继续命中缓存。
- runtime notice 只是行为提示，不是授权凭证；伪造它不能绕过 `PermissionPolicy`。
- `/clear` 生成**新的** session id 并继续写入新文件，不删除旧文件；权限模式（plan/ask/auto）保持不变。第一版不支持 Claude Code 的 `/clear [name]` 命名参数。
- `/resume` 先加载成功再切换，坏 id 不会打断当前对话；切换后写入目标会话文件，**当前进程模式不被目标会话的旧 policy 覆盖**（与启动时 `--resume` 不同——启动时进程刚起、没有已选模式）。

权限决策由 `packages/core/src/permissions.ts` 统一执行，宿主只负责界面：

- 每个工具声明 `capabilities`：`read` / `write` / `execute`。含写或执行能力的工具进入审批流程；缺少声明按最高风险处理。
- 预设决定默认决策：`plan` 直接拒绝；`ask` 在交互界面询问、在无头模式拒绝；`auto` 放行。
- 审批结果有三种：`allow`（本次）、`allow-session`（本进程内该工具不再询问，不落盘）、`deny`。
- 核心层 **fail-closed**：策略要求询问但没有 `approve` 回调时，工具不会执行。plan 模式根本不调用审批回调，宿主无法把它降级成 `ask`。
- 系统提示描述权限机制，但不写死当前模式；模式由 runtime notice 提供，策略实例仍是唯一执行边界。

审批面板按终端高度分页显示文件 diff 和长命令。文件在等待审批时发生变化，Cooper 会重新预览并询问。命令预览包含完整命令、shell 和工作目录。缺少效果预览时，面板会说明原因或标明预览不可用，并显示操作摘要。

审批面板按键：

- `←` / `→` 翻页，`y` 允许本次调用，`n` / `Esc` 拒绝。
- `a` 查看授权范围，再按 `y` 执行当前调用并授权该工具到进程退出。确认页按 `Esc` 返回预览，按 `n` 拒绝。`Enter` 不会批准。

进程内授权随对话切换保留。应用配置时实际 shell 发生变化，Cooper 会撤销 `run_command` 的授权。终端历史分开显示用户的批准决定和工具执行结果，沿用进程授权的结果会标明来源。

## 推理内容

部分兼容端点通过 `reasoning_content` 或 `reasoning` 返回推理文本。Claude 也可以返回 thinking 摘要。

- **默认**：不显示文本，只在运行时显示 `reasoning 12.3k chars` 的进度提示；端点报告推理 token 数时，每轮结束留一行 `· reasoned 1.2k tokens`
- **`--show-reasoning`**（或配置 `showReasoning: true`）：按完整行以暗灰色提交到滚动区；无头模式写到 stderr，stdout 仍然只有答案

推理展示事件只用于实时输出。续传字段由适配器按端点的协议要求处理。

- **Chat Completions**。OpenAI 官方接口通过 `tool_calls` 和 `tool_call_id` 衔接工具调用与结果，assistant 消息格式没有 `reasoning_content`。DeepSeek 的思考模式在请求带 `tools` 时要求完整回传保留历史中的 `reasoning_content`，也包括未调用工具的历史轮次。请求不带 `tools` 时，DeepSeek 会忽略该字段。适配器在 `Message.continuation` 中保存端点返回的 `reasoning_content` / `reasoning_details`，只回传给同一个 endpoint 和 model。[OpenAI API 参考](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create) · [DeepSeek 思考模式](https://api-docs.deepseek.com/guides/thinking_mode/)
- **Messages**。工具续传要求按原顺序回传完整 assistant `content`。Claude 的签名 `thinking` 和 `redacted_thinking` 块也须原样保留。适配器在 `continuation` 中保存完整有序的 `content` 并原样回传，不再拼接文本和工具调用。Claude 的部分模型还会校验生成 thinking 块时的请求前缀；本地压缩后适配器会保留可见块、丢弃失效的 thinking 块，而不是重放旧签名。DeepSeek 的 Messages 兼容端点同样要求在思考模式下续传完整 assistant `content`。[Claude 工具续传](https://platform.claude.com/docs/en/build-with-claude/thinking-tool-workflows) · [Claude 前缀校验](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking) · [DeepSeek Messages](https://api-docs.deepseek.com/guides/anthropic_api/)
- **Responses**。`openai-responses` 通过 `POST /responses` 流式生成文本，支持 Cooper 的本地工具和 MCP 工具。工具结果以 `function_call_output` 和对应的 `call_id` 回传。Cooper 使用 `store: false`，按原顺序在 `input` 中回放同一端点、同一模型返回的 items，包括 OpenAI 的 `encrypted_content` 或兼容端点返回的 `reasoning_text`。历史压缩或前缀变更后会跳过失效的推理项。[OpenAI 推理续传](https://developers.openai.com/api/docs/guides/reasoning) · [DeepSeek Responses](https://api-docs.deepseek.com/guides/responses_api/)

## 上下文管理

长会话不会撞上下文上限：每次请求前估算 token 数，超阈值就按"最便宜的先做"分三层处理。

| 层级 | 触发 | 动作 | 成本 |
|---|---|---|---|
| L1 剪枝 | 可用预算的 65% | 旧工具输出换成存根，保留最近 8 条原文 | 本地，无模型调用 |
| L2 摘要 | 80% | 把较早的对话总结成一条消息，压到 45% | 一次模型调用 |
| L3 截断 | 92% | 丢弃最旧的完整消息组 | 本地，必定成功 |

"可用预算" = 窗口 − 预留输出（默认 16384）。剪枝放第一位，因为工具输出是最大的浪费源；摘要压到 45% 而不是刚好过线，避免下一轮马上又触发。任何一层都不会把 `assistant.tool_calls` 和对应的 `tool` 结果拆开。

**窗口大小**按模型名查表（Claude / GPT / Gemini / DeepSeek / Kimi / Qwen / GLM 等），识别不了时假设 **200k**。TUI 的 `/status` 会标明窗口大小是否为估算值。如果 API 因上下文超限拒绝请求，Cooper 会压到上次请求大小的一半再重试一次。

**token 估算**不依赖 tokenizer：CJK 按约 1.1 token/字符、其余按 3.6 字符/token，再加上消息结构开销和工具 schema。端点返回 `usage` 时用真实值做指数滑动平均修正；不支持的端点会自动降级（`stream_options` 被拒后重试一次并记住）。

| `config.json` 字段 | 默认 |
|---|---|
| `context.window` | 按模型表，否则 200000 |
| `context.reserveOutputTokens` | 16384 |
| `context.compact` | `true` |
| `context.summaryModel` | 同主模型 |

在 `~/.cooper/config.json` 中设置 `context.window` 来指定总上下文窗口。TUI 的 `/status` 用当前消息和工具定义的估算 token 数除以这个窗口，显示占用比例。压缩阈值仍按扣除输出预留后的预算计算。

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

Cooper 在 Windows 默认使用系统自带的 Windows PowerShell 5.1，在 Linux 默认使用 Bash（`/bin/bash`），在 macOS 默认使用 zsh（`/bin/zsh`）。在 `~/.cooper/config.json` 中可以为 TUI 和 headless 选择其他 shell，例如：

```json
{
  "shell": { "kind": "pwsh" }
}
```

可选值为 `powershell`、`pwsh`、`cmd`、`sh`、`bash`、`zsh` 和 `git-bash`。`powershell`、`cmd` 和 `git-bash` 用于 Windows。`git-bash` 会查找 Git for Windows 的标准安装目录。也可以设置 `shell.executable` 为绝对路径，Windows 上选择 `bash` 时必须提供该路径。显式配置的 shell 不可用时，Cooper 会在启动时指出问题。没有安装 Bash 的精简 Linux 环境可配置 `"shell": { "kind": "sh" }`。审批界面会显示 shell 和工作目录，`/status` 会显示可执行文件路径。

内置文件工具和 `run_command` 的启动目录会校验真实路径，拒绝指向工作区外的符号链接和 Windows junction。获准启动的命令以当前操作系统用户的权限运行。

## MCP 工具

Cooper 可以作为 MCP 客户端，把本地或远程服务器的工具并入同一套审批、执行和会话流程。

配置文件使用标准的 `mcpServers` 格式：

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    },
    "remote": {
      "type": "http",
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ..." }
    }
  }
}
```

加载顺序（同名服务器后者覆盖前者）：

1. `~/.cooper/mcp.json` —— 用户级，默认加载
2. `<工作目录>/.cooper/mcp.json` —— 仅 `--mcp-project` 时加载
3. `--mcp-config <file>` —— 可重复，始终加载

启动 MCP 服务器等于执行外部程序，所以**默认不读工作区里的配置**，打开一个仓库不会自动运行任何命令。连接失败只告警并跳过该服务器，内置工具不受影响。

- 传输：stdio、Streamable HTTP、SSE
- 配置值按字面量使用，暂不支持 `${VAR}` 展开
- 工具名：`mcp__<server>__<tool>`，输入 Schema 原样交给模型
- **服务器暴露的 MCP 工具都按 `execute` 处理**，忽略服务器自报的 `readOnlyHint`：`plan` 拒绝、`ask` 询问、`auto` 放行
- 单次输出上限 30k 字符；图片/音频转成占位说明
- TUI 在启动时提示 MCP 告警和连接失败。用 `/mcp` 查看连接状态和工具数。无头模式在 stderr 显示这些信息，退出或中断时会关闭客户端和子进程。
- 支持 MCP resources；prompts、资源订阅与更新通知暂未接入

### MCP resources

只要配置了服务器（连接成功），Cooper 就提供 3 个共享只读工具：

| 工具 | 作用 |
|---|---|
| `mcp_list_resources` | 列出某服务器的资源 |
| `mcp_list_resource_templates` | 列出参数化 URI 模板 |
| `mcp_read_resource` | 按 URI 读取资源 |

- 每次调用都必须显式指定 `server`；不做跨服务器聚合。
- **按需读取**：连接服务器不会预加载资源内容，也不会自动注入上下文。
- 省略 `cursor` 时汇总全部分页；显式传入 `cursor` 时只取一页。
- 服务器缺少 resources 能力时返回空列表，读取会明确报错。
- 结果保留 URI / MIME / 文本；二进制 `blob` 转成说明文字，不内联 base64。
- 这 3 个工具是 `read`：`plan` 模式可读，`ask` 模式不弹审批；它们只读取显式配置的服务器，不执行服务器工具。

## 命令

```bash
npm run dev                                # 启动 TUI（从仓库根目录运行）
npm run dev -- -p "..." [--mode auto]      # 无头单次运行
npm run dev -- --cwd ../other-project      # 在别的工作区启动
npm run dev -- --sessions                  # 列出本工作区保存的会话
npm run dev -- --resume <id>               # 继续某个会话
npm run dev -- --no-session                # 本次不保存会话
npm run dev -- --mcp-project               # 加载工作区的 MCP 配置
npm run dev -- --mcp-config ./mcp.json     # 显式加载 MCP 配置（可重复）
npm run typecheck                          # 全仓库类型检查
npm test                                   # core + cli 单元测试
```

## 架构约定

1. `packages/core` 不依赖 Ink/React，也不直接写 stdout。它只产出 `AgentEvent`。
2. 每种界面（TUI / 未来的 desktop、server）都是事件的消费者。
3. 工具统一实现 `Tool` 接口，输入用 zod 定义，自动转成 JSON Schema 交给模型；MCP 工具直接透传服务器的 JSON Schema。
4. 每个工具声明 `capabilities`；写/执行能力由 `PermissionPolicy` 审批，缺失声明按危险处理，核心层 fail-closed。MCP 服务器暴露的 tools 一律声明 `execute`，不信任服务器标注；Cooper 自己的 MCP resources 适配器是 `read`。
5. 流式输出按完整行提交给 `<Static>`，live 区只保留未完成的一行。
6. Provider 统一实现 `Provider` 接口。协议续传数据存放在 `Message.continuation` 中，并按协议、endpoint、model 和历史 anchor 校验；不匹配的 payload 不会被重放。
7. 系统提示由 `apps/cli/src/system-prompt.ts` 统一生成，描述权限机制但不写死当前模式，TUI 与无头模式共用。当前模式作为追加的 `<cooper-runtime>` 通知进入对话，避免切换模式时让 provider 的 prompt cache 整体失效。项目指令由 `packages/core/src/instructions.ts` 读取，只追加在权限段之后。
