# Agent Note: 基础斜杠命令框架与首批 TUI 命令

Status: implemented

## Problem

TUI 只有 4 个写死的斜杠命令（`/help` `/plan` `/ask` `/auto`）：命令名硬编码在 `Set` 里，`/help` 文案手写，`app.tsx` 用 `if/switch` 分发。每加一个命令要改三处，且没有为用户自定义命令、MCP prompts 桥接留出结构。

用户还缺少一批基础运维命令：开新对话、手动压缩上下文、查看已存会话、查看 MCP 与工具清单、退出。

## Decision

### 注册表作为唯一事实来源

`apps/cli/src/commands.ts` 持有 `CommandSpec[]` 注册表（name、aliases、usage、description）。`parseCommand` 经别名表归一化后返回规范命令名，`commandHelp` 从注册表生成。`parseCommand` 的返回形状与 prompt/unknown 语义不变；handler 在 `app.tsx`（Ink 层），`commands.ts` 保持纯函数。格式化函数（`formatSessions` / `formatMcp` / `formatTools`）也在 `commands.ts`，与解析同层单测。

### 首批命令

| 命令 | 别名 | 行为 |
|---|---|---|
| `/clear` | `/new`、`/reset` | 开启空上下文的新对话 |
| `/compact` | — | 估计 token；低于摘要阈值则提示，否则 `prepareContext({ force: true })` 并按事件追加 checkpoint |
| `/sessions` | — | 列出本工作区已保存会话 |
| `/resume <id>` | — | 切换到已保存会话（唯一 id 前缀可命中）；**保持当前进程模式** |
| `/mcp` | — | 显示 MCP 服务器连接状态与工具数 |
| `/tools` | — | 列出工具及 `read`/`write`/`execute` 能力 |
| `/exit` | — | 退出 TUI |

`/help` 与三个模式命令保留，help 文案由注册表生成。

### `/clear` 语义（对齐 Claude Code）

Claude Code 中 `/clear`、`/new`、`/reset` 是同一命令的别名，语义是开新对话而非删除历史。Cooper 实现：

- 会话开启时（非 `--no-session`）：`SessionWriter.create` 生成**新** id 与文件，旧会话文件不动，仍可用 `--sessions` / `--resume` 找回；新文件立即写入当前 `policy` 与 mode runtime notice。
- 内存消息历史重置为 system prompt + 当前模式 notice；模式（plan/ask/auto）不重置。
- 终端写 ANSI（`ESC[2J ESC[H ESC[3J`）清屏与 scrollback，`<Static>` 换 `key` 重挂载，重绘启动横幅（含新会话 id）。
- 不支持 Claude Code 的 `/clear [name]` 命名参数。
- `--no-session` 时只重置内存与屏幕，`sessionsEnabled` 在 mount 时固定，clear 不会开始落盘。

### `/resume` 语义

- **先加载后切换**：`resumeSession` 失败（坏 id / 歧义 / 跨工作区）只报错，当前对话不动。
- 命中后 `SessionWriter.from(loaded)` 把写入目标切到该会话文件；旧文件已即时追加、无未保存状态，直接弃引用即可。
- 内存历史 = `[system, ...loaded.messages, permissionModeNotice(当前模式)]`，与启动 `--resume` 同构；滚动区用 `buildResumeView` 重建 + ANSI 清屏 + `<Static>` 重挂载（与 `/clear` 共用路径）。
- **模式保持当前进程的**（拍板选项 A）：模式是进程级状态，用户本进程显式设过的不应被一次对话切换改掉；切换后向目标会话补写 `policy` + runtime notice。这与启动时 `--resume` 恢复 plan/ask、忽略 auto 的行为**有意不同**——启动时进程刚起、没有已选模式可言。
- 支持 `findSessionFile` 的唯一前缀匹配；已在目标会话中则提示不动作。
- `--no-session` 下拒绝（与 CLI「`--resume` 不能配 `--no-session`」对齐）。

### 边界

- 所有命令只在空闲时可用（busy 期间统一提示等待或 Esc）；`/compact` 执行期间自行置 busy 并挂 AbortController，Esc 可中断摘要调用。
- 命令不发给模型、不写 message 记录；`/clear`、`/compact`、`/resume` 是碰会话文件的三个命令（新建 / checkpoint / 切换写入目标）。
- 参数校验从宽：多余参数忽略，与 `/auto please` 一致；`/resume` 是唯一必须带参数的命令，缺参报用法错误。

## Alternatives considered

**继续硬编码 `Set` + `switch`。** 改动最小，但 help、解析、分发三处漂移，每加一个命令都要同步；也没有别名机制。注册表把元数据收拢成一份数据，后续 MCP prompts / 用户自定义命令只需合并条目。

**把斜杠命令做成模型可见的 tool。** 模型可主动触发 `/clear` 等，权限边界模糊（清对话是用户意图），且命令本不该进对话历史。宿主命令保持在 UI 层。

**第一版就做命令选择器 / 补全菜单。** 有价值但不是基础命令的前置；注册表已可被选择器消费，留待后续。

**`/clear` 只清内存不清屏。** 与 Claude Code 及用户预期不符；Ink 的 `<Static>` 无法擦除已滚入 scrollback 的行，必须 ANSI 清屏 + 组件重挂载。

**`/clear` 复用同一会话文件并写空 checkpoint。** 语义变成「同一对话截断」，与 `/compact` 混淆；开新文件才对齐 new conversation，旧对话整体可恢复。

**`/compact` 无条件 `force=true`。** 小对话上也会花一次摘要调用且可能越压越大；先用估计值卡在 summarize 阈值下，低于阈值直接告知无需压缩，高于阈值才 `force: true` 一次压到位。

**`/resume` 恢复目标会话的 plan/ask 模式（对齐启动逻辑）。** 与启动一致看似统一，但 TUI 里模式是用户刚刚主动设的；切个对话就把权限改掉（甚至从 plan 放开到 ask）更 surprising。启动恢复是因为进程没有「当前模式」可言，条件不同。选了保持进程模式（选项 A）。

## Consequences

- 加命令 = 注册表加一行 + `handleCommand` 加一个 `case`；help 自动更新。别名冲突由「注册表唯一性」测试拦住。
- `/clear` 后旧会话仍可 `--resume`，`--sessions` 列表会变长；未提供批量清理，避免误删。
- 老 conhost 可能不支持 `ESC[3J` 清 scrollback：屏幕可能残留旧内容，但内存与会话状态已重置，不破坏一致性。
- `/compact` 复用 core 的 `prepareContext`，与自动压缩同一套阈值与 checkpoint 语义；`COOPER_CONTEXT_COMPACT=off` 时明确拒绝。
- Claude Code 的 `/clear [name]`（给旧会话命名）未做；见 README「下一步」。
- `/resume` 与启动 `--resume` 的模式语义有意分叉（见 Decision）；若未来要统一，应改启动侧向 TUI 对齐（启动也保持…不行，启动没有当前模式），或在 note 里显式记录两者的各自理由——现在已记录。
- 验证：`npm run typecheck` 与 `npm test` 通过（core 138 + cli 82）；覆盖别名解析、注册表唯一性、help 全量命令（含 `/resume <id>`）、三个格式化函数。
