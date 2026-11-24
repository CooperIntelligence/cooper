# 工具与权限

[源码文档](README.md)

这一页面向改动代码的读者：工具契约、权限决策的精确顺序、审批预览的生命周期、文件与命令的工作区边界。工具清单与审批按键的用户视角说明见 [使用参考](../USAGE.md)。

## 工具契约

[`Tool`](../packages/core/src/tools/tool.ts) 声明 `name`、`description`、`inputSchema`（zod）、`capabilities`、可选的 `summarize()` 与 `preview()`，以及 `execute(input, ctx, approvedPreview)`。

- [`toToolSpec()`](../packages/core/src/tools/tool.ts) 生成给模型的 JSON Schema：内置工具由 zod 推导；MCP 工具带 `jsonSchema` 时原样转发（先克隆再删掉 `$schema`，避免污染共享对象），此时 `inputSchema` 只是宽松解析器，权威校验由外部服务器完成。
- `capabilities` 取值 `read` / `write` / `execute` / `network`。**缺失或为空视为危险**，走受管控路径——这既覆盖类型系统强制新工具声明能力，也兜住外部来源省略元数据的情况。
- `summarize()` 是审批面板与状态行展示的内容，代替原始 JSON 参数；`preview()` 必须无副作用、不抛异常，无法给出有意义的预览时可以返回 `undefined`。
- 新工具经 [`index.ts`](../packages/core/src/index.ts) 导出，由 [宿主装配层](../packages/host/src/mcp.ts) 统一注册。MCP 工具一律声明 `execute`，服务器自报的 `readOnlyHint` 不参与决策。

### 工具命名

常用工作区操作采用简短的动作名 `read`、`edit`、`write`、`shell`。需要说明资源或操作范围时，用 `list_dir`、`web_fetch` 这类带限定词的名称。MCP 服务器工具使用 `mcp__<server>__<tool>`。

工具可以声明旧名 `aliases`。分发层接受旧名，按规范名执行权限检查、记录进程授权和发送执行事件。模型的工具列表只声明规范名，旧会话和新调用的历史保留模型原始工具名及调用 ID。

## 权限决策

[`PermissionPolicy.decide()`](../packages/core/src/permissions.ts) 按固定顺序求值，先命中的规则生效：

1. 只读工具（能力全为 `read`）直接允许。
2. `plan` 拒绝所有受管控工具，已有进程内授权在此模式无效。
3. Windows 和 Linux `auto` 对普通工作区 `edit` 和 `write` 验证目标与预览，`shell` 单独调用审核模型。其他受管控工具转人工，无头时拒绝。非 Windows 入口沿用现有策略。
4. `ask` 在非交互宿主拒绝。交互宿主检查有效的进程内授权，其他调用提示用户。

| 模式 | 只读工具 | 受管控工具 |
| --- | --- | --- |
| `plan` | 允许 | 直接拒绝 |
| 交互式 `ask` | 允许 | 询问用户，或沿用符合条件的进程内授权 |
| 无头 `ask` | 允许 | 直接拒绝 |
| `auto`（Windows / Linux，交互） | 允许 | 普通编辑通过校验后执行，shell 独立审核，敏感编辑和其他受管控工具转人工 |
| `auto`（Windows / Linux，无头） | 允许 | 普通编辑通过校验后执行，shell 独立审核，凡需人工审批的调用均拒绝 |
| `auto`（其他平台，CLI） | 允许 | 沿用自动批准策略，内置 shell 因无支持的沙箱而拒绝 |

`prompt` 只有在宿主真的提供了审批回调时才会出现；[`runAgent()`](../packages/core/src/agent.ts) 拿不到回调就按拒绝处理（fail-closed），因此忘记接审批不会变成无人值守执行。

进程内授权由 `grantSession()` 记录：按工具名、仅当前进程、不落会话；`supportsProcessGrant()` 只排除带 `network` 的工具（能力缺失时仍可授权），所以网络请求永远逐次确认。`setPreset()` 只能在空闲时调用，切换保留已有授权。实际 shell 发生变化时，宿主撤销 `shell` 的授权，避免批准过的命令换了个执行器还在生效。

## 审批与预览

[`requestToolApproval()`](../packages/core/src/agent.ts) 的生命周期：

1. 调用 `preview()`（异常被捕获，只影响预览，不影响审批）；预览为 `invalid` 时直接把原因作为错误结果回给模型。
2. 把 `summary`、`capabilities`、`preview` 交给宿主的审批回调。
3. `allow-session` 但工具不支持进程内授权时降级为拒绝。
4. `diff` / `command` 预览带 `revalidate()`：批准后执行前再校验一次，文件或工作目录已经变了就重新生成预览并再次询问（`previewChanged`），用户批准的始终是当前效果。

审批面板渲染在宿主侧：[`approval.tsx`](../apps/cli/src/approval.tsx) 负责交互与按键，[`preview.ts`](../apps/cli/src/preview.ts) 负责 diff 行与命令的展示；diff 的计算（公共前后缀 + LCS，超过 1,500 行整体粗化）在 [`diff.ts`](../packages/core/src/diff.ts)。Core 只给出前后文本与 hunk，不决定怎么画。

## 文件与命令

[`fs.ts`](../packages/core/src/tools/fs.ts) 与 [`shell.ts`](../packages/core/src/tools/shell.ts) 通过 [`paths.ts`](../packages/core/src/tools/paths.ts) 解析路径，[`resolveInRoot()`](../packages/core/src/tools/paths.ts) 的规则：

- 相对路径先按字面解析，越界立即拒绝；
- 再用 `realpath` 穿过已有符号链接与 Windows junction，新文件把缺失的后缀拼到真实父目录上；
- 解析结果必须仍位于真实工作区根之内，悬空链接、指向外部的链接一律拒绝；
- Windows 上额外拒绝盘符、流后缀、结尾的点/空格和设备名（`CON`、`PRN`、`AUX` 等），因为这些在打开时会被系统重新解释。

Windows `ask` 与 `auto` 中获准的内置 `shell` 都使用 MXC。工作区和单次调用的临时目录可写，网络访问被拒绝。Linux 采用 MXC Bubblewrap，默认使用独立的禁网命名空间。显式允许出站后，文件权限仍适用。沙箱不可用或启动失败时，调用返回错误。文件工具由宿主校验目标真实路径。 [Windows 沙箱](../.agents/notes/implemented/architecture/2026-11-21-auto-shell-sandbox.md)

`shell` 默认超时 120,000 ms，可传 1,000–600,000 ms。流式保留尾部 60,000 字符，最终输出保留头尾各 15,000 字符。目录条目最多 500 条。`grep` 默认返回 100 行，上限 500 行。默认 shell 和用户可见参数见 [使用参考](../USAGE.md)，平台选择由 [`resolveCommandShell()`](../packages/core/src/tools/shell.ts) 实现。

`read` 按零基 `offset` 分页流式读取，默认最多返回 400 行，显式 `limit` 可请求最多 2,000 行。每页正文上限 48,000 字符，页尾提示给出下一次 `offset`。超长行截断后，可以按提示设置 `limit: 1` 和零基 `column_offset` 继续同一行，偏移按 Unicode 码点计数。跳到下一行时只需使用提示里的下一行 `offset`。

`edit` 匹配 `old_string` 时将 LF 与 CRLF 视为等价，其余字符逐字匹配。新增换行沿用匹配位置所在行的行尾。文件末行没有换行时沿用前一行的行尾，文件没有任何换行时使用 LF。未替换的原文直接保留。多处匹配时会给出候选行号，显式传入 `replace_all` 可全部替换。

相关测试：[工具](../packages/core/test/tools.test.ts)、[权限](../packages/core/test/permissions.test.ts)、[审批面板](../apps/cli/test/approval.test.tsx)、[预览](../apps/cli/test/preview.test.ts)、[路径包含性](../.agents/notes/implemented/bug-fix/2026-11-11-workspace-real-path-containment.md)。
