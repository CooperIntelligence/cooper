# Cooper

一个 TUI 形式的 Coding Agent。当前处于**阶段 1**：完整编码闭环——读写文件、执行命令、审批控制。

## 目录结构

```
packages/core/
  src/types.ts                       消息 / 工具调用类型
  src/provider/types.ts              Provider 流式接口（与厂商无关）
  src/provider/openai-compatible.ts  OpenAI 兼容协议实现
  src/agent.ts                       Agent loop + 审批钩子（无 UI 依赖）
  src/tools/tool.ts                  工具接口 + zod → JSON Schema
  src/tools/paths.ts                 工作区路径逃逸防护
  src/tools/fs.ts                    list_dir / read_file / grep / write_file / edit_file
  src/tools/shell.ts                 run_command
apps/cli/
  src/index.tsx                      入口：解析参数、切换 TUI / 无头
  src/args.ts                        命令行参数解析（纯函数，可单测）
  src/app.tsx                        Ink + React TUI + 审批面板
  src/headless.ts                    无头单次运行（stdout=回复，stderr=工具活动）
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

审批面板按键：

- `y` 本次允许
- `a` 本次会话内始终允许该工具
- `n` / `Esc` 拒绝（模型会收到拒绝结果并继续解释）

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
npm run typecheck                          # 全仓库类型检查
npm test                                   # core + cli 单元测试
```

## 架构约定

1. `packages/core` 不依赖 Ink/React，也不直接写 stdout。它只产出 `AgentEvent`。
2. 每种界面（TUI / 未来的 desktop、server）都是事件的消费者。
3. 工具统一实现 `Tool` 接口，输入用 zod 定义，自动转成 JSON Schema 交给模型。
4. 会修改工作区或执行命令的工具必须标记 `requiresApproval`，审批由宿主回调决定。
5. 流式输出按完整行提交给 `<Static>`，live 区只保留未完成的一行。
6. Provider 统一实现 `Provider` 接口，厂商差异只存在于适配器内部。
7. 系统提示由 `apps/cli/src/system-prompt.ts` 统一生成，TUI 与无头模式共用，避免两侧规则漂移。

## 下一步

- 上下文 token 计数、超限裁剪与压缩
- 会话持久化与 `--resume`
- Anthropic 原生适配器、MCP 客户端
- 自动格式化 / linter 集成，测试失败自动回灌
