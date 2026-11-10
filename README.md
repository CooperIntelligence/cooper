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
  src/home.ts                        COOPER_HOME / ~/.cooper 解析
  src/mcp/config.ts                  MCP 配置与信任规则
  src/mcp/client.ts                  MCP 连接、工具列表、生命周期
  src/mcp/resources.ts               MCP resources 的共享工具与结果投影
  src/mcp/tool.ts                    MCP tool → Tool 适配
apps/cli/
  src/index.tsx                      入口：解析参数、切换 TUI / 无头
  src/args.ts                        命令行参数解析（纯函数，可单测）
  src/commands.ts                    TUI slash 命令解析（纯函数，可单测）
  src/app.tsx                        Ink + React TUI + 审批面板
  src/headless.ts                    无头单次运行（stdout=回复，stderr=工具活动）
  src/preview.ts                     审批面板的 diff 行构造
  src/session-view.ts                恢复会话时重建滚动区
  src/system-prompt.ts               系统提示（两种界面共用）
  src/stream-lines.ts                流式文本按行切分
  src/provider.ts                    根据配置构造 Provider
  src/mcp.ts                         加载可信 MCP 配置并组装工具
  src/config.ts                      配置聚合（flag > env > 配置文件 > 默认）
  src/settings.ts                    ~/.cooper/config.json 与项目层加载校验
```

## 快速开始

要求 Node.js 20+（当前在 Node 26 上验证）。

```bash
npm install
cp .env.example .env        # Windows PowerShell: Copy-Item .env.example .env
# 编辑 .env，至少填 COOPER_API_KEY
npm run dev
```

`COOPER_PROVIDER` **显式**选择协议，默认 `openai`（不按模型名猜测，因为 Claude 也可能通过 OpenAI 兼容网关提供）：

| 协议 | 配置 | 默认模型 |
|---|---|---|
| OpenAI 兼容（默认） | `COOPER_API_KEY` 或 `OPENAI_API_KEY` | `gpt-4o-mini` |
| Anthropic 原生 | `COOPER_PROVIDER=anthropic` + `ANTHROPIC_API_KEY` | `claude-opus-5-5` |

`COOPER_BASE_URL` 支持任何 OpenAI 兼容端点，例如：

| 供应商 | COOPER_BASE_URL | COOPER_MODEL |
|---|---|---|
| OpenAI | `https://api.openai.com/v1` | `gpt-6-astra` |
| DeepSeek | `https://api.deepseek.com` | `deepseek-flash` |
| Moonshot | `https://api.moonshot.cn/v1` | `kimi-k3.1-pro` |

Anthropic 原生协议使用 `ANTHROPIC_BASE_URL`（可选），输出上限由 `COOPER_MAX_OUTPUT_TOKENS` 控制（默认 64000）。同时设置时，`ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` 优先于通用的 `COOPER_BASE_URL`，避免切换提供商时被旧的端点配置带偏。对支持 adaptive thinking 的 Claude 模型，适配器会请求摘要式 thinking，`--show-reasoning` 因此可用；旧模型自动省略该参数。

## 配置

配置分四个通道，各管一段生命周期：

| 通道 | 放什么 | 生命周期 |
|---|---|---|
| `~/.cooper/config.json`（user 层） | 非密偏好：provider、model、baseURL、`apiKeyEnv`、调参、默认 mode | 长期，跨项目 |
| `<workspace>/.cooper/config.json`（project 层，可提交） | 项目级覆盖（见下方限制） | 长期，随仓库 |
| `.env` / shell 环境变量 | **只有 API key**；`COOPER_*` 变量保留为单次/CI 覆盖 | 长期（密钥）/ 临时 |
| CLI flag / 斜杠命令 | flag：单次运行（`--model`、`--mode`…）；命令：会话内（`/plan`、`/auto`…） | 单次 / 会话 |

**每个 key 独立取最高优先级**：`flag > env > project 配置 > user 配置 > 内置默认`。`/status` 显示每个生效值及其来源层。

配置文件示例（JSON，严格校验；未知字段告警并忽略，JSON 损坏直接报错）：

```jsonc
// ~/.cooper/config.json
{
  "provider": "anthropic",          // 协议，显式，不按模型名猜
  "model": "claude-sonnet-5-5",
  "baseURL": "https://gateway.example/v1",
  "apiKeyEnv": "CORP_KEY",          // 指针：去哪个 env 变量找 key
  "maxOutputTokens": 64000,
  "showReasoning": false,
  "mode": "ask",                    // user 层可为 plan|ask|auto
  "context": {
    "window": 200000,               // 省略则按模型表，未知模型假设 200k
    "reserveOutputTokens": 16384,
    "compact": true,
    "summaryModel": null
  }
}
```

规则：

- **API key 永远只从 env 读**（bring your own key）。配置里只写 `apiKeyEnv` 指针；解析顺序：指针指向的变量 → `COOPER_API_KEY` → `OPENAI_API_KEY`/`ANTHROPIC_API_KEY`。配置文件里出现 `apiKey` 之类的密钥字段会告警并忽略。
- **project 层不能碰网络**：`provider`、`baseURL`、`apiKeyEnv` 只允许 user 层 / env / flag。clone 下来的仓库无法把你的 key 重定向到自己的服务器（与 MCP 需要 `--mcp-project` 同一威胁模型）。project 层出现这些字段会告警并忽略。
- **project 层不能设 `mode: "auto"`**：仓库不能自我放行；auto 只能来自 `--mode auto`、`COOPER_MODE`、TUI `/auto` 或 user 层配置。
- mode 优先级：`--mode` > `COOPER_MODE` > 会话保存的 plan/ask > 配置文件 > `ask`。会话保存的 `auto` 仍不隐式恢复（落空到配置层再决定）。

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
- **面向用户的推理内容不落盘**（规则 15）。Anthropic 的签名 thinking 块是协议续传数据，作为 `providerData` 随消息保存；它不会显示，也不会发往其他厂商。**“本次会话始终允许”也不落盘**：重启后权限重新询问，不会因为旧会话静默放行工具。
- system 提示不落盘，恢复时按工作目录和项目指令重新生成；它不包含当前模式，保持字节稳定以复用 provider 的 prompt cache。
- 当前模式作为 `policy` 记录追加到会话；模型看到的模式说明是带 `runtime: "permission-mode"` 的 `<cooper-runtime>` 消息，TUI 和恢复视图会过滤它，不把它显示成用户输入。
- 恢复会话时按 `--mode` > `COOPER_MODE` > 会话记录的 `plan`/`ask` > 配置文件的 `mode` > 默认 `ask` 的顺序决定模式；**已保存的 `auto` 不会隐式恢复**（落空到配置层，配置里显式写了 `auto` 才生效），否则必须显式 `--mode auto` 或在 TUI 里 `/auto`。
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
| `/status` | — | 显示生效配置：每个值、来源层（flag/env/project/user/default）与配置文件路径 |
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

唯一例外是 Anthropic 的**签名 thinking 块**：带工具调用时 API 要求原样回传。适配器把它们作为不透明协议数据保存在 assistant 的 `providerData` 中，只回传 Anthropic，不渲染进历史、不混入文本、不发往其他厂商；恢复 Anthropic 会话时也会一并保存，否则下一次请求可能被拒绝。

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

| 变量（env 覆盖，优先于配置文件） | 默认 | 配置文件对应字段 |
|---|---|---|
| `COOPER_CONTEXT_WINDOW` | 按模型表，否则 200000 | `context.window` |
| `COOPER_CONTEXT_RESERVE` | 16384 | `context.reserveOutputTokens` |
| `COOPER_CONTEXT_COMPACT` | `on` | `context.compact` |
| `COOPER_SUMMARY_MODEL` | 同主模型 | `context.summaryModel` |

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
- 启动横幅和无头 stderr 显示每台服务器的连接状态与工具数；退出或中断时关闭客户端和子进程
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
6. Provider 统一实现 `Provider` 接口，厂商差异只存在于适配器内部。Anthropic 的签名 thinking 块存放在 `providerData`，只回传给 Anthropic。
7. 系统提示由 `apps/cli/src/system-prompt.ts` 统一生成，描述权限机制但不写死当前模式，TUI 与无头模式共用。当前模式作为追加的 `<cooper-runtime>` 通知进入对话，避免切换模式时让 provider 的 prompt cache 整体失效。项目指令由 `packages/core/src/instructions.ts` 读取，只追加在权限段之后。
