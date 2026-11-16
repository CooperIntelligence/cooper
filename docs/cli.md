# CLI 与配置

[源码文档](README.md)

这一页面向改动代码的读者：参数解析与入口分流、无头输出契约、流式渲染规则、配置加载与热更新。参数、斜杠命令和配置字段的完整清单见 [使用参考](../USAGE.md)。

## 入口与分流

[`parseArgs()`](../apps/cli/src/args.ts) 是纯函数：不读文件、不读环境变量，因此可以直接单测（[测试](../apps/cli/test/args.test.ts)）。它同时负责组合约束——只允许一个提示、`--resume` 与 `--no-session` 互斥、`--sessions` 不能带提示——并在解析失败时给出可执行的错误信息。

[入口](../apps/cli/src/index.tsx)决定三种去向：TUI、单次无头请求、列出会话。`--sessions` 在读取配置之前执行，因此配置缺失时仍能查看会话。工作区由 `--cwd` / `-C` 指定，[`resolveRoot()`](../apps/cli/src/index.tsx) 校验它是存在的目录，随后 `process.chdir()`，使文件工具、命令启动目录、项目指令、项目级 MCP 配置和会话归属同一个根。

## 无头输出契约

[`runHeadless()`](../apps/cli/src/headless.ts)把回答写 stdout，其余一律 stderr：工具进度、会话状态与 id、模式提示、指令来源、MCP 状态、诊断，以及 `--show-reasoning` 打开时的推理。stdout 保持「只有回答」，才能安全地重定向给脚本。

- 退出码：成功 `0`；请求错误、空提示、Skill 解析失败或达到轮次上限 `1`；被中断 `130`。
- 无人可审批，宿主创建 `PermissionPolicy({ preset, interactive: false })`，`ask` 与 `plan` 对受管控工具一律拒绝，并在 stderr 写出提示，引导用户传 `--mode auto`。
- 会话写入失败只报告 `session not saved: …`，不改变退出码；恢复会话时会报出修复的无效行数。
- 中断通过 `SIGINT` 触发同一个 `AbortSignal`，同时终止模型请求与可取消的工具。

## TUI 流式渲染

[`stream-lines.ts`](../apps/cli/src/stream-lines.ts)把增量拆成行：每个完整行只向 Ink 的 `<Static>` 提交一次，动态渲染区只保留未完成的尾行。Ink 无法擦除已经滚进回滚缓冲的行，若把整段不断增长的文本实时重绘，会在终端历史里重复内容（Windows 上尤其明显）。推理行遵循同样的追加规则。恢复的历史由 [`session-view.ts`](../apps/cli/src/session-view.ts) 重建。

## 配置生命周期

[`settings.ts`](../apps/cli/src/settings.ts) 负责读取与写入 `~/.cooper/config.json`：

- 文件不存在是正常状态；JSON 语法错误是硬错误，且错误信息不回显文件内容，避免把凭据带进日志。
- 未知字段、疑似密钥的其他键、旧的 `env` 对象、`mode: "auto"` 只警告并忽略——打字不会静默改变行为，但也不会被吞掉。
- 类型或取值不匹配是硬错误（[测试](../apps/cli/test/settings.test.ts)）。
- 保存先写同目录临时文件（POSIX 上 `0600`，目录 `0700`）、`fsync`、检查保存期间文件是否被外部修改，再 `rename` 替换；失败时清理临时文件。

[`config.ts`](../apps/cli/src/config.ts) 从解析结果计算有效值：四个连接字段缺失时抛 [`IncompleteConfigError`](../apps/cli/src/config.ts)（携带缺失字段与警告），`baseURL` 必须是绝对 http(s) 地址，窗口按模型表推断或取配置值，`sources` 记录每个值来自 flag、配置文件还是默认值，供 `/status` 展示。

- **首次引导**：只有 `IncompleteConfigError` + 交互式 TUI + stdin/stdout 都是 TTY 时才进入；[引导](../apps/cli/src/onboarding.tsx)会用实际配置发起一次请求检查连接，取消则退出并提示手工写入路径。无头与其他配置错误一律直接失败。
- **配置编辑器**：[`config-editor.tsx`](../apps/cli/src/config-editor.tsx) 中 Enter 进入编辑并暂存、Ctrl+S 保存并应用，编辑态的 Esc 先清空输入退回浏览、再按一次才关闭编辑器；API 密钥遮罩显示，可编辑字段是固定的一张表（`webSearch`、`defaultTier`、`modelTiers` 不在其中）。
- **`/reload`**：重新校验并应用外部编辑；校验或保存失败时继续使用已生效的配置。切换端点后，现有对话从下一轮起发往新端点，协议续传数据仍按 [Provider 的身份规则](providers.md)过滤（[测试](../apps/cli/test/reload.test.tsx)）。
- `--show-reasoning` 覆盖文件中的 `showReasoning`。

## 模式选择

[`resolveModeForSession()`](../apps/cli/src/args.ts) 实现优先级：显式 `--mode` > 会话保存的 `plan`/`ask` > 配置的 `plan`/`ask` > `ask`。会话里保存过 `auto` 而没有显式旗标时不会被恢复，入口据此生成 `modeNotice`（TUI 显示、无头写 stderr）。配置文件与环境变量都不能选择 `auto`。系统提示里的权限文案来自同一策略实例，模式本身由[运行时通知](../packages/core/src/runtime-notice.ts)携带，见 [架构总览](architecture.md)。

相关测试：[参数](../apps/cli/test/args.test.ts)、[配置](../apps/cli/test/config.test.ts)、[设置](../apps/cli/test/settings.test.ts)、[无头](../apps/cli/test/headless.test.ts)、[引导](../apps/cli/test/onboarding.test.ts)、[热更新](../apps/cli/test/reload.test.tsx)、[流式行](../apps/cli/test/stream-lines.test.ts)、[恢复视图](../apps/cli/test/session-view.test.ts)。
