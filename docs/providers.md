# 模型协议与档位

[源码文档](README.md)

这一页面向改动代码的读者：Provider 接口、三个协议适配器、协议续传的身份与前缀校验、模型档位的切换流程。协议选择与档位配置见 [使用参考](../USAGE.md)。

## Provider 接口

[`Provider`](../packages/core/src/provider/types.ts) 只有三个成员：

- `stream(request)`：输入模型 ID、共享消息、工具定义与取消信号，产出 `text` / `reasoning` 增量和一条 `done`（含完整 assistant 消息、用量）。序列化与流解析全部由适配器负责，Agent 循环因此保持厂商无关。
- `protectedToolHistoryLength?()`：适配器声明「这段历史在当前工具轮里不能改写」的长度，[压缩](context-and-sessions.md)据此决定能否编辑前缀。
- `estimateInputTokens?()`：按**真实请求格式**估算输入（含符合重放条件的续传数据），档位切换与 `useProviderEstimate` 场景优先使用它。

CLI 的 [`createProvider()`](../apps/cli/src/provider.ts) 按显式 `protocol` 构造适配器，不靠猜测。

## 三个协议适配器

| `protocol` | 适配器 | 工具对齐与请求要点 |
| --- | --- | --- |
| `openai-chat` | [Chat Completions](../packages/core/src/provider/openai-compatible.ts) | 用 `tool_calls` / `tool_call_id` 对齐结果；配置了模型选项时发送 `reasoning_effort` 与 `max_completion_tokens`；兼容端点可续传 `reasoning_content`、`reasoning` 或 `reasoning_details`（数组块按 `index` 合并以保持顺序） |
| `openai-responses` | [Responses](../packages/core/src/provider/openai-responses.ts) | `store: false` + `include: ["reasoning.encrypted_content"]`，按顺序回放输出 items，工具结果映射为带 `call_id` 的 `function_call_output`；工具 `strict: false`；发送 `max_output_tokens`，模型选项可设 `reasoning.effort` |
| `anthropic-messages` | [Messages](../packages/core/src/provider/anthropic.ts) | 内容块承载调用与结果，`max_tokens` 默认 64,000；支持的模型发 adaptive thinking（`display: "summarized"`）与 `output_config.effort`（`none` / `minimal` 不发送） |

各自的降级与防御行为：

- Chat Completions 对不接受 `stream_options.include_usage` 的端点（400/422 且报错提到该字段）重试一次并记住不再发送；用量只是校准手段，不能让它打断 Agent。工具调用的 `finish_reason` 与实际调用是否出现必须一致，缺失、重复或空参数都会直接抛错。
- Responses 用 `baseURL` 作为 API 根路径（SDK 拼接 `/responses`）；开启推理显示时请求 `summary: "auto"`，端点拒绝摘要参数时去掉该参数重试一次；**必须等到 terminal `response.completed` 才把工具调用交给循环**，进行中的响应不算完成。
- Messages 把连续的工具结果合并成一条含多个 `tool_use` 的消息；`stop_reason` 不是 `tool_use` 却带工具调用、参数 JSON 不完整或 id 重复时抛错。被 `max_tokens` 或窗口截断的响应**不生成续传**——半截的 thinking 不能进下一次请求。
- Chat Completions 与 Responses 关闭了 SDK 重试（`maxRetries: 0`），请求级重试策略由上层掌控；Messages 未显式设置，沿用 SDK 默认。

## 展示与协议续传

`reasoning-delta` 只用于当轮展示，生命周期随终端输出结束；`Message.continuation` 才是下次请求必须重放的原始协议数据。[`continuation.ts`](../packages/core/src/provider/continuation.ts) 定义它的身份与锚点：

- **所有者** = 协议 + 端点（`baseURL` 的 sha256，绝不含密钥）+ 实际模型 ID。三者不全等就不重放，档位名和显示名只供宿主使用。协议枚举里还有 `gemini`，仓库暂无对应适配器，只是为续传预留的命名空间。
- **作用域**：`message` 只依赖所在消息（前缀改动无关）；`prefix` 依赖此前的全部请求内容（Anthropic 的签名 thinking 属于此类）；`response` 依赖整次响应（Responses / Gemini 的 items 属于此类）。
- **锚点**：`messageAnchor` 是 assistant 可见字段（正文 + 工具调用）的规范化 JSON 哈希，`historyAnchor` 是请求前缀的滚动哈希（种子包含系统提示与工具列表）。锚点不匹配就丢弃依赖该前缀的部分，保留可见内容与工具调用。
- 压缩编辑历史后，[`invalidatePrefixContinuations()`](../packages/core/src/provider/continuation.ts) 把非 `message` 作用域的续传标记为 `stale`，载荷本身保留——可见块仍然精确。过期后各适配器只丢弃依赖前缀的部分：Messages 过滤 `thinking` / `redacted_thinking`，Responses 过滤 `reasoning` 项并保留 `function_call`，Chat Completions 整体不再回放推理字段；旧式 `providerData` 形状由 Provider 自有，直接删除。
- 重放前还要校验载荷与可见字段的一致性：Messages 逐个核对 `tool_use` 的顺序、数量与参数 JSON，Responses 用 zod 校验 items 并回算锚点，对不上就丢弃载荷、按可见内容重建，绝不把不匹配的续传发出去。
- [`protectedToolHistoryLength()`](../packages/core/src/provider/anthropic.ts) 只在「进行中的工具轮 + 未过期 + 所有者与锚点全对 + 存在签名 thinking」时返回保护长度，此时压缩只能 stub 新追加的工具结果。
- 会话回放与 TUI 历史只呈现可见内容，续传载荷由适配器消费，从不渲染。

相关测试：[续传锚点](../packages/core/test/continuation.test.ts)、[Messages](../packages/core/test/anthropic.test.ts)、[Chat Completions](../packages/core/test/openai-compatible.test.ts)、[Responses](../apps/cli/test/responses.test.ts)。

## 实验性模型档位

配置结构见 [使用参考](../USAGE.md)。实现侧的约束与流程：

- [`config.ts`](../apps/cli/src/config.ts) 按「档位 `contextWindow` → 顶层 `context.window` → 模型窗口表」依次确定窗口；配置了档位时，每档与兜底模型的有效窗口至少 256,000 tokens，`maxOutputTokens` 必须小于对应窗口。
- [`validateModelRequest()`](../packages/core/src/provider/model-request.ts) 校验协议与模型是否接受给定的 `reasoningEffort`（例如 Anthropic 官方端点上的 `none` / `minimal` 不支持）。
- 选择顺序：`--tier` > 会话保存的档位 > `defaultTier` >（配置了档位时）`cher`；选中的档位缺少独立配置时回退到顶层模型。
- [`model-transition.ts`](../apps/cli/src/model-transition.ts) 用目标适配器的 `estimateInputTokens` 对比 `contextInputLimit()`：预算不足时 TUI 显示估算与上限，确认后 `compactForModel()` 在副本上压缩（保留最新可见消息），成功才提交切换并写 `model-switch` checkpoint；无头模式直接报告原因、以退出码 1 结束，不发请求也不改会话文件。
- 恢复会话时只要任一端有档位、或新 `inputLimit` 小于保存值，就触发同样的预算检查；切回大窗口则继续使用当前有效历史。

相关测试：[档位与切换](../apps/cli/test/model-tiers.test.tsx)（含三个协议的请求参数与无头超限保护）、[配置解析](../apps/cli/test/config.test.ts)。
