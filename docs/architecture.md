# 架构总览

[源码文档](README.md)

这一页面向改动代码的读者：包边界、一次请求的完整路径、Agent 循环的事件契约，以及系统提示的组装规则。参数、命令和配置的用法见 [使用参考](../USAGE.md)。

## 包边界

Cooper 使用 npm workspaces。

- [`apps/cli`](../apps/cli/package.json) 负责命令行启动、参数解析、Ink/React 渲染、审批交互与退出码。
- [`apps/desktop`](../apps/desktop/package.json) 负责 Electron 窗口、桌面交互和进程间通信。
- [`packages/host`](../packages/host/src/index.ts) 提供两端共用的配置、Provider 工厂、工具装配、系统提示和模型切换校验。
- [`packages/core`](../packages/core/src/index.ts) 是内核：Provider、Agent 循环、工具、权限、上下文与会话。

内核不 import Ink/React，不写 stdout，也不读 stdin；一切对外可见的状态都以 [`AgentEvent`](../packages/core/src/agent.ts) 从 `runAgent()` 流出，由宿主决定如何渲染和持久化。相对导入统一使用 `.js` 扩展名（NodeNext 解析）。

## CLI 启动与请求流程

1. [入口](../apps/cli/src/index.tsx) 调用 [`parseArgs()`](../apps/cli/src/args.ts)，再解析工作区目录并 `process.chdir()`，使工具、子进程与会话共享同一根目录。`--sessions` 在读取配置之前就能列出会话并退出。
2. [`loadConfig()`](../packages/host/src/config.ts) 读取 `~/.cooper/config.json`。缺少必填的连接字段时，只有「交互式 TUI 且 stdin/stdout 都是 TTY」才进入[首次引导](../apps/cli/src/onboarding.tsx)，其余情况直接报错退出。
3. 入口加载项目指令、按需恢复会话、确定生效的模型档位与权限模式（顺序见 [`resolveModeForSession()`](../apps/cli/src/args.ts)），创建会话写入器、Provider，发现 Skills，并[装配内置工具与 MCP 工具](../packages/host/src/mcp.ts)。退出或中断时统一关闭 MCP 客户端与子进程。
4. [TUI](../apps/cli/src/app.tsx) 与[无头宿主](../apps/cli/src/headless.ts)各自构建消息历史：系统提示 + 恢复的历史 + 最新的模式通知 + 用户提示，并创建自己的 `PermissionPolicy`，再把 Provider、工具、消息、工作区根目录和取消信号交给 `runAgent()`。
5. [Agent 循环](../packages/core/src/agent.ts)每轮先准备上下文，调用 `Provider.stream()`，把文本与推理增量转成事件；收到完成事件后追加一条 assistant 消息（协议续传数据随消息保存）。
6. 模型请求工具时，循环解析并用 zod 校验输入、执行[权限决策](tools-and-permissions.md)，再按调用 ID 追加工具结果并请模型继续。未知工具、无效参数、权限拒绝都会以错误结果回给模型，而不是中断循环；模型不再请求工具时结束，默认最多 25 个模型轮次。
7. 宿主消费事件完成渲染、审批与持久化。中断沿同一个 `AbortSignal` 传给模型请求与支持取消的工具，包括 `shell`、MCP 和网页抓取。

若端点以「上下文过长」拒绝请求，且本轮尚未向用户输出任何文本，循环会把上一次的估算减半作为新预算强制压缩，并至多重试一次；无法压缩时原样抛出错误。

## Desktop 启动与请求流程

[Electron 主进程](../apps/desktop/src/main.ts)打开本地页面和原生目录选择器，会话、Provider、工具权限及审批复查由[主进程运行时](../apps/desktop/src/runtime.ts)管理。`sandbox` 与 `contextIsolation` 都启用，[预加载脚本](../apps/desktop/src/preload.ts)暴露固定的 IPC 操作。发送给渲染器的数据包括可见对话、工具结果、审批内容与状态。Provider 配置、协议续传数据和审批回调保留在主进程中。

选中的目录作为配置装配、工具和会话的工作区根路径。Desktop 与 CLI 读取相同的配置和 JSONL 会话。Desktop 的审批界面提供单次允许和拒绝，支持在空闲时切换 `plan` 和 `ask`。

## 事件契约

[`AgentEvent`](../packages/core/src/agent.ts) 是宿主与内核之间唯一的接口：

| 事件 | 含义 | 去向 |
| --- | --- | --- |
| `turn-start` | 一轮模型请求开始 | 宿主用于状态显示 |
| `text-delta` | 回答文本增量 | 实时渲染，不单独落会话 |
| `reasoning-delta` | 展示用推理增量 | 仅当轮显示，不进消息、不落会话 |
| `assistant-done` | 一条完整 assistant 消息（含工具调用、用量、续传数据） | 落会话 |
| `tool-start` / `tool-end` | 工具开始与结果（含耗时、是否拒绝/出错） | `tool-end` 落会话 |
| `tool-approval` | 审批结果：`allow` / `allow-session` / `deny` | 宿主状态显示，不落会话 |
| `context-compacted` | 发生了压缩，附前后估算与动作 | 落会话与提示 |
| `max-turns` | 达到轮次上限仍未结束 | 宿主据此返回失败 |

显示用推理与协议续传是两类数据：前者是易失的展示内容，后者是下次请求必须原样重放的协议数据，规则见 [模型协议与档位](providers.md)。

## 系统提示与运行时消息

[系统提示生成器](../packages/host/src/system-prompt.ts)由各宿主共用，从**实际生效的权限策略实例**取用权限说明，保证文字与执行一致。`interactive` 对进程固定，因此这段文字不会随模式变化。

顺序是：身份与工作区 → 权限规则 → 三种模式的语义 → 工作偏好 → Skill 目录（每条含名称与描述，共用 16,000 字符预算）→ 项目指令。权限规则永远在项目指令之前，项目指令可以约定工作方式，但不能覆盖权限。

[指令加载器](../packages/core/src/instructions.ts)从 `~/.cooper` 和工作区根目录各选一个文件，优先 `COOPER.md`，其次 `AGENTS.md`；个人指令在前、项目指令在后，两份正文共用 32,000 字符预算，超出部分截断并标记。

当前权限模式放在 `runtime: "permission-mode"` 的 [`<cooper-runtime>` 消息](../packages/core/src/runtime-notice.ts)中，按用户角色追加。切换模式只追加新通知，不改写系统提示和更早的消息，从而保持已发送的前缀稳定（前缀缓存友好）；压缩会重新附加最新通知，使模式始终对模型可见。通知只负责让模型知道该怎么做，真正的授权仍由 `PermissionPolicy` 决定。

## 本地开发

```bash
npm install
npm run dev              # 启动 TUI
npm run typecheck
npm test
```

测试位于 [Core](../packages/core/test) 与 [CLI](../apps/cli/test)。[构建脚本](../scripts/build.mjs)把 CLI 打包到 `apps/cli/dist/cooper.mjs`，npm 包通过该文件提供 `cooper` 命令。
