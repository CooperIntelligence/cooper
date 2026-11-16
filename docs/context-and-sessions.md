# 上下文与会话

[源码文档](README.md)

这一页面向改动代码的读者：token 估算与预算数学、压缩的分组不变量、JSONL 持久化与恢复修复。配置字段的默认值见 [使用参考](../USAGE.md)。

## 输入预算

[`estimator.ts`](../packages/core/src/context/estimator.ts) 不依赖厂商 tokenizer，按字符启发式估算：CJK 每字符 1.1 token，其余每 3.6 字符 1 token（单一的「字符数 ÷ 4」会把中文低估 3–4 倍）。每条消息固定开销 4，assistant 的每个工具调用再加 8 加上参数文本；`continuation.payload` 与工具 schema 每次请求都会重发，因此都计入总量。

端点返回的输入用量会逐轮校准估算：观测比值限制在 `[0.5, 1.5]`，首个样本直接采用，之后按 `0.7 × 旧 + 0.3 × 新` 加权，样本最多 50 个。档位切换等场景可用适配器对真实请求格式的估算（`estimateInputTokens`），再乘同一个校准系数。

[`window.ts`](../packages/core/src/context/window.ts) 用**有序正则表**推断模型窗口，首个命中即生效；全部不命中按 200,000 tokens 并标记 `assumed`（`/status` 会显示 `(assumed)`）。这张表是启发式而非承诺：高估可以靠端点拒绝后的重试存活，低估只会让压缩更早发生。

[`contextInputBudget()`](../packages/core/src/context/budget.ts) 的确切公式：

```
heuristic = min(reserveOutputTokens, floor(window * 0.25))
budget    = max(1, window - max(heuristic, maxOutputTokens ?? 0))
limit     = floor(budget * 0.92)
```

输出预留默认 16,384，但最多占总窗口的 25%；请求级 `maxOutputTokens` 与预留取较大者作为扣除项；结果至少 1 token。两个分母不要混淆：`/status` 的占用百分比以**总窗口**为分母，压缩阈值与 `limit` 以**可用输入预算**为分母。

## 压缩

[`prepareContext()`](../packages/core/src/context/budget.ts) 在副本上尝试压缩，只有结果确实更小时才提交；先便宜后昂贵，逐级降级：

| 阈值（占可用预算） | 动作 |
| --- | --- |
| 65% | 把较早的工具输出原位替换为存根。保留最近 8 条，不够再降到 4 条、2 条；只 stub 长于 1,000 字符的结果，若 stub 反而不省则跳过 |
| 80% | 分块摘要较早的完整消息组。保留量为 `max(1024, 目标 − 1200)`，目标是可用预算的 45%；前缀不足 2,400 token 时不值得调用摘要器，直接跳过 |
| 92% | 先 stub 未决的大工具结果，再从最旧的完整消息组开始删除，直到降到 45% 目标；删不动（单条超大消息主导）就整体回滚，保留原历史 |

不变量：

- 开头的连续 system 块永不压缩；最新一组即使超预算也保留。
- [`groupMessages()`](../packages/core/src/context/groups.ts) 把 assistant 工具调用与其全部结果视为原子组，压缩只能发生在组边界，工具结果只 stub 不删除——协议要求每个调用都有结果。显式 Skill 通知与其附带的用户请求也成一组。
- 摘要替换成一条带固定前缀的 user 消息，预算 1,200 token，分块大小取 `min(60_000, max(8_000, 可用预算 × 0.5))`。**摘要失败绝不阻塞请求**：异常被吞掉继续走截断，摘要「不回本」则还原前缀。
- 删除的组会留下一条占位 user 消息，提示模型重新读文件或重跑命令。
- 最新的权限模式通知必须存活：被摘要或删除带走时原样重挂，保证模式始终对模型可见。
- 有动作时调用 [`invalidatePrefixContinuations()`](../packages/core/src/provider/continuation.ts)，把依赖被编辑前缀的续传数据标记为 `stale`，见 [模型协议与档位](providers.md)。
- 仍超限时抛错并保留原历史；若适配器要求保留进行中的工具轮（`protectedToolHistoryLength > 0`），只能 stub 新追加的结果，错误信息会说明原因。

端点以「上下文过长」拒绝时，[`runAgent()`](../packages/core/src/agent.ts) 在**本轮尚未向用户输出任何文本**的前提下，把上一次估算减半作为新预算强制压缩，至多重试一次；没有产生任何动作就原样抛出。

## 持久化与恢复

[`session.ts`](../packages/core/src/session.ts) 把会话追加到 `~/.cooper/projects/<工作区标识>/sessions/<id>.jsonl`。工作区标识由路径规范化后派生（win32 先转小写），文件以 `0600` 创建；恢复时校验会话归属，跨工作区拒绝。

| 记录 | 作用 |
| --- | --- |
| `session` | 头部：版本、id、绝对工作区路径、初始模型、创建时间 |
| `message` | 用户、assistant、工具消息与宿主运行时通知；工具消息附带展示元数据 |
| `checkpoint` | 压缩或模型切换后的有效历史快照（不含 system） |
| `policy` | 生效的权限预设；进程内授权从不落盘 |
| `model-selection` | 生效的模型选择 |

写入规则：

- system 消息**从不存储**——恢复时按当前工作区重新生成，存下来的必然过期。
- 事件只有 `assistant-done`、`tool-end`、`context-compacted` 三类落盘；展示推理与文本增量不落盘。用户消息、模式通知与 `policy` 记录由宿主在对应时机单独追加。checkpoint 在每次压缩之后写入，模型切换改写历史时写 `model-switch` checkpoint。
- 加载从**最后一个 checkpoint** 起算，其后的消息再逐条回放；更早的记录只作审计。
- 写入失败只报告一次 `session not saved`，不中断对话；例外是模型切换的 checkpoint 写失败会中止该次切换。

恢复规则：

- 坏 JSON 行、未知记录类型、非法 policy/model-selection 一律跳过并计数；**缺头部或版本不符是硬错误**，绝不静默恢复垃圾。
- [`repairEntries()`](../packages/core/src/session.ts) 修复尾部不完整组：进程可能死在「记录 assistant 调用」与「记录结果」之间，缺结果的调用组与孤立的工具结果会被整段丢弃，否则回放会让后续所有请求失败。
- 恢复视图过滤运行时通知、压缩占位与续传数据，只呈现可见内容；展示推理与进程内授权只存在于运行中。
- `--resume` 只带回 `plan` / `ask`，保存过的 `auto` 不会隐式恢复；新进程要 `--mode auto`，TUI 也可空闲时 `/auto`。
- 恢复后若档位变化导致预算不足：无头模式报告原因并以退出码 1 结束（不发请求、不改会话文件），TUI 弹确认、压缩成功后才提交切换。

相关测试：[估算](../packages/core/test/estimator.test.ts)、[分组](../packages/core/test/groups.test.ts)、[压缩与预算](../packages/core/test/context.test.ts)、[会话与恢复](../packages/core/test/session.test.ts)、[恢复视图](../apps/cli/test/session-view.test.ts)、[模式恢复](../apps/cli/test/args.test.ts)、[无头存档往返](../apps/cli/test/headless.test.ts)。
