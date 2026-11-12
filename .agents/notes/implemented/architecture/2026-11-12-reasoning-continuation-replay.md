# Agent Note: Reasoning Continuation Is Protocol State, Not Display Text

Status: implemented

## Problem

Cooper 目前把模型返回的思维链整体当成“展示数据”处理：适配器把推理增量转成 `reasoning` 事件给 UI，`runAgent` 只转发 `reasoning-delta`，真正需要进入下一次请求的协议字段没有进入消息、会话或请求体。这个判断只在 Anthropic 的签名 thinking 块上开了一个例外，对 OpenAI Chat Completions 家族的 `reasoning_content` 完全缺失。结果不是“少显示一点推理”，而是带 `tools` 的思考模式直接不可用。

当前代码的具体表现：

- `packages/core/src/provider/openai-compatible.ts:131-141` 只把 `reasoning_content` / `reasoning` 转成展示事件；`done` 消息（同文件 `:170`）不带任何续传数据；`toOpenAIMessages`（`:21-50`）也不会把 `reasoning_content` 写回 assistant 消息。DeepSeek 在带 `tools` 的思考模式下要求把历史 `reasoning_content` 完整回传，缺失时返回 400。Kimi、GLM、Qwen 的保留式思考同理。
- `packages/core/src/provider/anthropic.ts:77-112` 只保存 signed `thinking` / `redacted_thinking` 块；`:176-187` 再用 `content` + `toolCalls` 重新拼 assistant 消息。Anthropic 要求把 assistant `content` 原样回传；重建消息、改变交错顺序或过滤 `redacted_thinking` 都可能返回 400。
- `packages/core/src/context/prune.ts:64` 改写旧 tool 结果；`packages/core/src/context/budget.ts:206` 用摘要替换前缀，`:236` 丢弃最旧的完整消息组。对 Anthropic，这些都是在 thinking 块之前修改历史；新模型会校验 prefix、model 和 account，重放旧块会返回 400。
- `packages/core/src/session.ts:272-274` 在 resume 时丢弃 system prompt 并由宿主重新生成；`:572-573` 也不持久化 system prompt。Anthropic 的 prefix 包含 system prompt 和 tools，重建后与生成 thinking 块时的 prefix 不一致，resume 后重放同样可能 400。
- `packages/core/src/provider/anthropic.ts:242` 的 `allowLegacyThinking` 默认 `true`，会把来源 endpoint/model 不明的 thinking 块发给当前 endpoint。这是跨端点重放，既可能 400，也可能把思维链发给不该看到它的端点。
- `packages/core/src/context/estimator.ts:41-52` 不把续传 payload 计入 token。一旦开始回传，`reasoning_content` 会实际占用输入 token，但预算看不见，压缩会偏晚，最终以 context-length 400 收场。

根因在决策层，而不只在两个适配器。`AGENTS.md` 规则 15/16 把“推理文本”整体归为展示数据，只给“provider 要求的签名续传块”开例外，并把“签名”当成协议数据的判据。这个判据不成立：

- DeepSeek 的 `reasoning_content` 没有签名，但带 `tools` 时必须回传；
- OpenAI Responses 的 reasoning item 是 `encrypted_content`，是加密而不是签名；
- Gemini 的是 `thoughtSignature`；
- Anthropic 的才是 signed thinking block。

正确的判据是“提供方是否要求下一轮原样带回”，而不是密码学形态。`packages/core/test/agent.test.ts:327-331` 的注释“DeepSeek rejects it being sent back”正是这个错误决策的产物，与 DeepSeek 文档相反。

`README.md` 的“推理内容”一节其实已经正确描述了这两个缺陷（`openai-chat` 只展示、Anthropic 重建消息与 prefix 校验），但 `AGENTS.md` 的硬规则仍沿用旧框架；实现者优先读 `AGENTS.md`，于是继续把 reasoning 当展示数据。这是决策文档必须先改的原因。

影响面：

- DeepSeek / Kimi / GLM / Qwen 的带工具思考循环在第二跳就 400，主路径不可用。
- Claude 的交错 thinking、tool use 续传、压缩后重放、resume 后重放都可能 400。
- 跨 endpoint 重放来源不明的 thinking 块，存在思维链泄露风险。
- 会话恢复后，即使没有 400，模型也失去了之前的推理连续性。

## Decision

Cooper 把“展示用 reasoning”和“协议续传数据（continuation）”拆成两类数据，并把 continuation 提升为 `Message` 的一等字段。核心不解释 continuation 的内容，只负责保存、随消息移动、计入预算，并把它原样交给适配器；协议/端点/模型/anchor 的校验由产生它的适配器完成。

五条硬性结论：

1. `Message` 增加 `continuation`，与 `reasoning-delta` 展示事件彻底分开。
2. `openai-chat` 必须累计并回传 `reasoning_content`（以及 OpenRouter 的 `reasoning_details`），不能只展示。
3. `anthropic-messages` 必须原样 echo 整个 assistant `content`，不再用 `content` + `toolCalls` 重建。
4. 压缩、剪枝、resume 后按 `scope` 和 anchor 丢弃失效 payload；默认不允许跨 endpoint/model 重放。
5. `estimateMessageTokens` 计入 continuation；`AGENTS.md` 规则 15/16 与测试注释同步改写。

### 1. 证据：各协议的实际要求

| 协议 / 端点 | 响应中的续传字段 | 何时必须回传 | 形式与顺序要求 | 缺失或错误的后果 |
|---|---|---|---|---|
| DeepSeek Chat Completions | `reasoning_content` | 请求带 `tools` 时，所有历史轮次都要回传，即使某轮没有工具调用；不带 `tools` 时忽略该字段 | 原样回传 assistant 消息中的 `reasoning_content`；不要改写、截断、总结 | HTTP 400，提示 thinking 模式的 `reasoning_content` 必须回传 |
| Kimi（Moonshot） | `reasoning_content` | K3.1 Pro / K3 始终保留；K2.7-code 始终保留；K2.6 跨轮需 `thinking.keep: "all"`；单轮工具循环内全部保留 | 把 API 返回的完整 assistant message（含 `reasoning_content`）原样放回 `messages` | 工具循环上下文断裂；保留式思考失效或报错 |
| GLM（Z.ai） | `reasoning_content` | 交错思考在 tool 结果返回时保留 thinking 块；Preserved Thinking（`clear_thinking: false`）要求完整回传 | 所有连续 `reasoning_content` 必须与原始生成序列完全一致，不得重排或编辑 | 推理质量下降、缓存命中下降，或请求被拒 |
| Qwen（DashScope / OpenAI 兼容） | `reasoning_content` | 思考模式下与工具调用配对回传；agent 场景的 `preserve_thinking` 要求历史 reasoning 回传 | 与 OpenAI Chat Completions 相同的 assistant 消息形状；具体模型以文档为准 | 缺少工具调用消息中的 reasoning 时可能请求失败 |
| OpenRouter | `reasoning_details`（也接受 `reasoning` / `reasoning_content` 别名） | 工具调用续传时必须回传；跨轮保留可由 `reasoning.context` 控制（仅部分模型支持） | `reasoning_details` 是结构化数组，必须原样、按原顺序回传；加密/摘要块不能简化成字符串 | 推理不连续；Anthropic 等模型可能 400 或丢失加密上下文 |
| Anthropic Messages | `content` 中的 `thinking` / `redacted_thinking` 块及 `signature` | 返回 tool result 时，assistant 消息中的 thinking 块必须随 tool_use 一起回传 | 原样 echo 整个 assistant `content`；不得重建、重排、过滤 `redacted_thinking`；thinking 块必须与对应 tool_use 同消息 | 400（invalid signature、expected thinking block、重建消息等） |
| Anthropic 新模型的前缀绑定 | — | 每个 thinking 块绑定生成时的 system + tools + 之前的 messages，以及 model / account | 历史必须 append-only；任何在块之前的编辑都会使该块及其后块失效；客户端压缩后不得重放旧块 | prefix mismatch 400；或 `input_transformations` 标记 `thinking_dropped` |
| OpenAI Responses | `reasoning` item，含 `encrypted_content` | `store: false` 的无状态模式，下一轮必须把 reasoning item 按原顺序放回 `input` | 保留 `content` / `summary` / `signature` / `encrypted_content` 不变；function_call_output 追加在其后 | 多轮推理状态丢失；工具循环可能无法继续 |
| Gemini | function call part 上的 `thoughtSignature`；最终 text part 也可能带签名 | 工具循环中所有 function call 的签名都要回传；跨模型迁移的自定义 function call 需要 dummy signature | 签名随对应 part 原样回传；不得重排 function call 与 response 的顺序 | 签名缺失/错位会降低复杂 agent 流程的质量；部分路径可能校验失败 |

来源：

- DeepSeek：[Thinking Mode — Tool Calls](https://api-docs.deepseek.com/guides/thinking_mode/#tool-calls)
- Kimi：[思考模型：reasoning_content、多轮保留策略、工具调用](https://platform.kimi.com/docs/guide/use-thinking-models.md)
- GLM：[Thinking Mode — Interleaved / Preserved Thinking](https://docs.z.ai/guides/capabilities/thinking-mode)
- Qwen：[OpenAI compatible — Chat Completions](https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-openai-chat-completions)
- OpenRouter：[Reasoning Tokens — Preserving Reasoning](https://openrouter.ai/docs/use-cases/reasoning-tokens)
- Anthropic：[Thinking in tool and multi-turn workflows](https://platform.claude.com/docs/en/build-with-claude/thinking-tool-workflows)、[Preserved thinking](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking)、[Thinking](https://platform.claude.com/docs/en/build-with-claude/thinking)
- OpenAI Responses：[Use the Azure OpenAI Responses API — Encrypted reasoning](https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/responses)
- OpenAI Chat Completions：[Create chat completion](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)
- Gemini：[Thought signatures](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures)
- DeepSeek 的 Anthropic 兼容端点同样要求思考模式下续传完整 assistant `content`：[Anthropic API](https://api-docs.deepseek.com/guides/anthropic_api/)

四条共同结论：

1. 推理内容不总是展示数据。只要端点要求下一轮原样带回，它就是协议状态，必须进入请求。
2. 续传 payload 是按协议定义的、往往有序且不透明的结构。把它压缩成一个通用 `reasoning: string` 会丢失签名、加密块、`reasoning_details` 和交错顺序。
3. 续传绑定生成它的 protocol / endpoint / model，有时还绑定整个历史前缀或上一个 response。跨 provider、跨 endpoint、跨 model 重放无效且有泄露风险。
4. 客户端压缩、剪枝、resume 都是对历史的编辑。对 prefix 绑定的协议，编辑之后不能继续重放旧块。

### 2. 两个概念与一条边界

| 概念 | 载体 | 生命周期 | 谁能读 | 是否持久化 |
|---|---|---|---|---|
| 展示推理 display reasoning | `reasoning-delta` 事件 | 仅当前进程的实时展示 | TUI / headless 的显示层 | 否 |
| 协议续传 continuation | `Message.continuation` | 跟随所属 assistant 消息，直到消息被删除或 payload 失效 | 产生它的适配器 | 是（会话与 checkpoint） |

边界规则：

- display reasoning 永远不进入 `messages`、会话文件、headless stdout。`--show-reasoning` 仍只写 stderr。
- continuation 永远不作为对话内容渲染，不进入用户可见的 session view，不进入摘要请求。
- 核心（`packages/core` 中除适配器外的部分）不解析 continuation 的 payload；它只透传 `protocol`、`scope`、`messageAnchor` / `historyAnchor` 和消息归属，校验由拥有 payload 的适配器完成。
- 适配器只读写自己 `protocol` 的 payload；看到别的协议一律忽略。
- continuation 可以包含推理文本（DeepSeek/Kimi），也可以包含签名或密文（Anthropic/Responses/Gemini）；“是否签名”不是分类依据。

### 3. 数据模型

共享类型定义在 `packages/core/src/provider/continuation.ts`，由 `types.ts` 和两个适配器复用：

```ts
export type ContinuationScope = "message" | "prefix" | "response";

export type Continuation = {
  /** 产生这个 payload 的 wire protocol。 */
  protocol:
    | "openai-chat"
    | "anthropic-messages"
    | "openai-responses"
    | "gemini";
  /** sha256(baseURL)，只标识端点，绝不包含 API key。 */
  endpoint: string;
  model: string;
  /** payload 对什么范围有效。 */
  scope: ContinuationScope;
  /** assistant 可见字段（content + toolCalls）的哈希；任何 scope 都要校验。 */
  messageAnchor: string;
  /**
   * 仅 scope "prefix" / "response" 需要。
   * prefix: system + tools + 此前全部消息的滚动哈希。
   * response: 上一个 response id 或整段历史的哈希。
   */
  historyAnchor?: string;
  /** 不透明、保序的 wire payload；只有拥有它的适配器读取。 */
  payload: unknown;
};
```

`Message` 的 assistant 分支增加 `continuation?: Continuation`：

```ts
| {
    role: "assistant";
    content: string;
    toolCalls?: ToolCall[];
    continuation?: Continuation;
  }
```

`AssistantMessage`（`packages/core/src/provider/types.ts`）和 `AgentEvent.assistant-done` 也同样增加 `continuation?: Continuation`。

`messageAnchor` / `historyAnchor` 的计算方式：

- 适配器在发请求前，用同一套确定性序列化计算 rolling hash：`seed = sha256(canonical({ system, tools }))`，然后对每条此前消息按**实际会发送的 wire 形态**（包括此前消息已经保留的 continuation）计算 `h = sha256(h + canonical(wireMessage))`。这样删掉更早的 thinking 块会让之后所有 `historyAnchor` 一起失效，符合 Anthropic 的“不能有缺口”规则。
- `messageAnchor` 对所有 scope 都计算：`sha256(canonical(assistant 的 content + toolCalls))`，不包含它自己的 continuation，避免自引用。消息被改写就丢弃 payload。
- 对 `scope: "prefix"`，`historyAnchor` 是这条 assistant 消息之前那一刻的 `h`。重放时重新走到这条消息，比较 `h`；不一致就丢弃 payload。
- 对 `scope: "response"`，`historyAnchor` 用上一个 response id；没有 id 的端点用整段历史的哈希。历史变了就丢弃。
- 对 `scope: "message"`，不需要 `historyAnchor`。
- `canonical` 必须是确定性 JSON：递归排序 object key、UTF-8、不包含 `undefined`、不包含时间戳或随机值。
- 任一校验失败时静默丢弃（可记 debug 指标），绝不把旧 payload 发出去。

向后兼容：

- 新增 `continuation`；`providerData` 保留为只读的 legacy 字段，解析旧会话时读取，适配器只在显式 `allowLegacyThinking` 时使用。
- 新代码只写 `continuation`，不再写 `providerData`。等旧会话不再需要恢复后删除 legacy 路径。
- 旧 `providerData.anthropic.thinking` 可映射为 `protocol: "anthropic-messages"`、`scope: "prefix"`、无 `messageAnchor` / `historyAnchor` 的 legacy continuation；默认丢弃，除非调用方显式允许。

### 4. 适配器规则

#### OpenAI Chat Completions（DeepSeek / Kimi / GLM / Qwen）

- 流式过程中累计 `reasoning_content`，不要只 yield `reasoning` 事件；`reasoning` 事件仍然只用于展示。
- 如果端点返回 `reasoning_details`（OpenRouter 或兼容实现），保存完整结构化数组，不要只拼文本；流式增量按 index/type 合并，最终以非流式或完整字段为准。
- 记录端点实际使用的字段名（`reasoning_content` 还是 `reasoning`），回传时使用同一个字段名，避免把 `reasoning_content` 发给只认 `reasoning` 的端点。
- `done` 时附加：

  ```ts
  continuation: {
    protocol: "openai-chat",
    endpoint: sha256(baseURL),
    model,
    scope: "message",
    messageAnchor: hashAssistantMessage(content, toolCalls),
    payload: { field, reasoningContent, reasoningDetails },
  }
  ```

  OpenRouter 也走 `openai-chat` 这一种 wire protocol；不需要单独的 protocol 值。payload 里记录实际字段名和 `reasoning_details`，适配器按“端点返回过什么就回传什么”处理。

- `toOpenAIMessages` 增加当前 endpoint/model 参数。对每条 assistant 消息：
  - 若 `continuation?.protocol` 匹配、`endpoint` / `model` 匹配、`messageAnchor` 匹配，则把 payload 中的字段写回 wire message；
  - 否则不发这些字段，只发可见的 `content` / `tool_calls`；
  - 不要为官方 OpenAI 合成 `reasoning_content`：官方 Chat Completions 不返回该字段，也没有续传语义；
  - `reasoning_details` 必须原样、按原顺序写回，不能重排或简化。
- 带 `tools` 的请求中，历史 assistant 消息即使没有工具调用也要带 `reasoning_content`（DeepSeek 明确要求所有历史轮次）。不带 `tools` 时也带上无妨，DeepSeek 会忽略；但如果端点对未知字段严格，仍以“该端点曾返回过该字段”为前提。

#### Anthropic Messages

- 不再只存 thinking 块。把 `finalMessage().content` 整个有序数组原样存入 payload：

  ```ts
  continuation: {
    protocol: "anthropic-messages",
    endpoint: sha256(client.baseURL),
    model,
    scope: "prefix",
    messageAnchor: hashAssistantMessage(content, toolCalls),
    historyAnchor: rollingHistoryHash,
    payload: { content: message.content }, // 原样，包含 text / thinking / redacted_thinking / tool_use
  }
  ```

- 重放时，如果 payload 有效，直接把它作为 assistant `content` 使用，不要再用 `content` + `toolCalls` 重建。文本块、thinking 块、redacted 块、tool_use 块的顺序必须与 API 返回时完全一致。
- 不要过滤 `redacted_thinking`；不要合并 text 块；不要移动 thinking 块到数组开头；不要重排 tool_use。
- 如果 payload 缺失或校验失败，才回退到现有重建逻辑；回退时不要声称这是“精确续传”。`allowLegacyThinking` 默认改为 `false`。
- endpoint / model 必须匹配。`historyAnchor` 覆盖 system + tools + 之前所有消息；system prompt 重新生成、tools 列表变化、压缩剪枝都会使 historyAnchor 失效，从而自动丢弃旧块。`messageAnchor` 覆盖 assistant 消息本身，防止消息被编辑后仍重放旧 content。
- 对 Anthropic 的新模型，可以在请求里加 `thinking.block_binding.prefix_mismatch_behavior: "drop_block"`（需要对应 beta header）作为兜底，但不要依赖它来掩盖客户端的编辑错误；客户端仍应先做 `messageAnchor` / `historyAnchor` 校验。
- DeepSeek 的 Anthropic 兼容端点同样要求完整 assistant `content`；协议仍记为 `anthropic-messages`，endpoint 不同自然隔离。

#### OpenAI Responses / Gemini

- Responses 适配器使用 `store: false` 和 `include: ["reasoning.encrypted_content"]`。payload 保存有序的 reasoning、function_call 和 message items。只有 `response.completed` 后才交付工具调用。`scope: "response"` 的归属和锚点匹配时按原顺序回传，密文保持原样。
- Gemini：payload 保存带 `thoughtSignature` 的 parts，`scope: "response"`；所有 function call 的签名都要回传，最终 text part 的签名保留。
- Gemini 当前只有 envelope 定义，后续适配器沿用同一套归属和锚点规则。

### 5. Agent Loop 规则

`runAgent` 的职责是传输，不是解释：

- 收到 `done` 后，把 `event.message.continuation` 原样挂到新的 assistant 消息上；有 toolCalls 和没有 toolCalls 的分支都要挂。
- `assistant-done` 事件带上 `continuation`，供 session recorder 持久化；TUI / headless 不渲染它。
- `reasoning` 事件继续只产生 `reasoning-delta`，绝不写入 `messages`。
- 任何情况下都不把 continuation 传给 `summarizeMessages` 的摘要请求。
- context-length 重试只应针对真正的上下文错误。continuation 校验失败（例如 invalid signature）不属于 context error，不能触发“压缩后再试”，否则会把一个协议错误变成反复重试。
- provider / model 切换不需要 loop 做特殊处理：适配器会在下一次请求时按 `protocol` / `endpoint` / `model` / `messageAnchor` / `historyAnchor` 丢弃不匹配的 payload。loop 不应替适配器“清洗” continuation，否则会重新引入 vendor 逻辑。
- headless stdout 仍然只有答案；`--show-reasoning` 的 stderr 行为不变。

### 6. 压缩、恢复与 token 预算

#### 压缩

continuation 的失效边界由 `scope` 决定。实现采用保守策略：只要一次压缩动作真正提交，就把**所有** `prefix` / `response` payload 标记为 stale；`message` payload 保留。

| 压缩动作 | `scope: "message"` | `scope: "prefix"` / `"response"` |
|---|---|---|
| `pruneToolOutputs` 改写旧 tool 结果 | 保留（assistant 消息没变） | 标记 stale；adapter 只发可见块 |
| `summarizeMessages` 替换前缀 | 保留被保留的 assistant 消息的 payload | 标记 stale |
| 截断最旧组 | 保留 | 标记 stale |
| 重新追加 runtime notice | 保留 | 保留（append-only，不触发压缩动作） |

实现上：

- 自动压缩、上下文超限重试和手动压缩共用 `prepareContext`。活跃的 Anthropic 签名工具轮次由适配器标出受保护前缀，压缩延后到工具轮次结束。超过硬上限时可以缩小本次尚未发送的工具结果，因为它们位于签名覆盖的前缀之后。前缀和必需内容仍超限时，本地报错并保留原历史。
- 普通压缩提交前调用 `invalidatePrefixContinuations(messages)`。payload 仍保存有序的可见块，适配器继续按 `historyAnchor` 和 `stale` 判断思考块能否重放。
- `scope: "message"` 不因前缀变化而失效；只有所属 assistant 消息被删除或改写时才丢弃。
- `scope: "prefix"` / `"response"` 在压缩后一律标记 stale。Anthropic 的 thinking 块被过滤后，保留的 assistant tool_use 消息在 adaptive thinking 下仍然合法（thinking 块存在时必须伴随 tool_use，不存在时不强制）；如果将来启用 manual extended thinking，则要连同该 tool_use 组一起删除，避免“有 tool_use 无 thinking 块”的 400。
- `messageAnchor` / `historyAnchor` 校验是最后一道防线。即使某条压缩路径忘记调用 `invalidatePrefixContinuations`，适配器也会因为 anchor 不匹配而过滤旧 payload；清理只是节省内存和会话体积，不是正确性的唯一保证。
- 不要在压缩后把旧 thinking 块“补回去”。Anthropic 明确说移除后再放回会使期间生成的块失效。

#### 恢复

- system prompt 和 tools 不持久化，resume 时由宿主重新生成。Anthropic 的 prefix 包含二者，所以 resume 后 `historyAnchor` 可能全部不匹配。
- 这是安全默认：不匹配就只保留可见的 text/tool_use 块、丢弃 thinking，不把旧块发给新 prefix。代价是 resume 后模型失去之前的推理连续性；这比 400 或跨端点重放更可取。
- 如果希望 resume 保留推理连续性，需要把生成时的 system prompt / tools 指纹一并持久化，并在 resume 时逐字节复用；这与当前“system prompt 每次运行重新生成”的规则冲突，应作为独立决策，不要在本笔记里偷偷改变。
- checkpoint 必须包含 `continuation`，否则压缩后的 resume 会丢失正在进行的工具循环所需的续传数据。
- session view、`--resume` 的对话回放只读 `content` / `toolCalls`，不读 `continuation`。

#### token 预算

- `estimateMessageTokens` 必须把 continuation payload 计入。对明文 reasoning 用现有的 `estimateTextTokens`；对加密/签名块用序列化长度估算（base64 约 4 字符/token）。
- 否则会在第一次带 reasoning 的请求上严重低估输入 token，压缩触发过晚，最终 context-length 400。
- 计入后压缩会更早触发，这是正确的：这些 token 确实会被计费。
- 摘要请求不发送 continuation，所以 `summarizeMessages` 的内部预算不需要计入它；只有主请求的 `estimateContextTokens` 需要。

### 7. 现有决策文档的修正

本笔记取代以下表述；这些位置已在本变更中修正，避免下一位维护者继续按旧规则实现。

| 位置 | 现有说法 | 为什么错 | 应改为 |
|---|---|---|---|
| `AGENTS.md` 规则 15 | “Reasoning/thinking text emitted for display must stay out of `messages`…唯一例外是 provider-required signed continuation blocks” | 把“推理文本”整体归为展示数据，只用“签名”识别协议数据；DeepSeek 的未签名 `reasoning_content` 同样必须回传 | 分开定义 display reasoning 与 protocol continuation；continuation 包括未签名的 `reasoning_content`、`reasoning_details`、encrypted items、thought signatures；判据是“端点要求下一轮原样带回” |
| `AGENTS.md` 规则 16 | “Never persist user-facing reasoning…Signed provider continuation blocks in `providerData` are protocol data and may be persisted” | 只允许持久化签名块；未签名的 `reasoning_content` 被误判为“user-facing reasoning” | 持久化所有 protocol continuation payload；继续禁止持久化 display reasoning；session 必须 round-trip continuation |
| `packages/core/test/agent.test.ts:327-331` | 注释“DeepSeek rejects it being sent back”，断言历史里不能出现 reasoning 文本 | 与 DeepSeek 文档相反；它把“不要进入 `content`”误写成“不要回传” | 断言 display reasoning 不在 `content` / 用户可见历史；断言 continuation 在 `continuation`（旧会话为 `providerData`）中并可被下一个请求重放 |
| `README.md:81` | “Cooper 当前缺少这项续传能力，后续请求可能收到 HTTP 400” | 作为缺陷描述是准确的，但不应作为可接受的现状 | 修复后改为“适配器会按协议回传 `reasoning_content`”；未修复前保留“已知缺陷”措辞 |
| `README.md:273` | “Cooper 当前的 `openai-chat` 适配器只展示推理增量” | 描述的是 bug，不是设计 | 修复后改写为“适配器在 `continuation` 中保存并回传 `reasoning_content` / `reasoning_details`” |
| `packages/core/src/types.ts:12-18` | `ProviderData` 注释以 Anthropic 为例，暗示它是 Anthropic 专属 | 实际是所有协议的通用槽位 | 改为 `Continuation`，说明协议、端点、模型、scope、两个 anchor 的边界 |
| `packages/core/src/provider/types.ts:26-27` | “Display-only reasoning text. The adapter handles protocol continuation data.” | 对 `openai-chat` 适配器不成立 | 明确区分 display event 与 `continuation` 字段；适配器必须实现后者 |

规则 15/16 的替换文本：

```text
15. Display reasoning and protocol continuation are different data.
    - Display reasoning (`reasoning-delta`) is ephemeral: never in `messages`,
      session files, or headless stdout. Headless stdout carries only the answer.
    - Protocol continuation is the exact payload the provider requires on the
      next request. It includes unsigned `reasoning_content` (DeepSeek, Kimi,
      GLM, Qwen), OpenRouter `reasoning_details`, Anthropic signed thinking
      blocks, OpenAI Responses reasoning items, and Gemini thought signatures.
      It lives in `Message.continuation`, is persisted, and is replayed only to
      the same protocol / endpoint / model. It is never rendered as
      conversation history.
    - Display reasoning must never be used as continuation, and continuation
      must never be shown to the user.
```

```text
16. Session files are append-only JSONL... Never persist user-facing display
    reasoning or in-session "always allow" state. Protocol continuation
    payloads — including unsigned `reasoning_content` and encrypted or signed
    blocks — are protocol data and may be persisted so a resumed session can
    replay them. Validate their owner and both anchors before replay; never send
    a payload to a different protocol, endpoint, or model.
```

### 8. 实施结果

- `packages/core/src/provider/continuation.ts`：`Continuation` / `ContinuationScope`、确定性 `canonicalJson`、`hashAssistantFields`、`historySeed` / `extendHistoryHash`、owner 校验，以及 `invalidatePrefixContinuations`。
- `packages/core/src/types.ts` 与 `provider/types.ts`：assistant 消息和 `AssistantMessage` 增加 `continuation`；`providerData` 只作为旧会话的 legacy 读取路径。
- `openai-compatible.ts`：流式累计 `reasoning_content` / `reasoning_details`，在 `scope: "message"` 的 continuation 中保存；`toOpenAIMessages` 只在 protocol / endpoint / model / `messageAnchor` 全部匹配时写回。
- `anthropic.ts`：保存完整有序的 `message.content`，在 `scope: "prefix"` 的 continuation 中保存；重放时原样 echo。`historyAnchor` 不匹配时保留可见块、只丢弃 thinking；`allowLegacyThinking` 默认 `false`。
- `agent.ts` 把 continuation 挂到 assistant 消息并带上 `assistant-done`。`context/budget.ts` 处理压缩前缀保护、失效标记和最终预算检查。
- `session.ts`：消息和 checkpoint 持久化 continuation；旧 `providerData` 继续可读。
- `estimator.ts`：把 continuation payload 计入输入 token。

- `openai-responses.ts`：无状态重放 Responses items。服务端仅需处理当前 `input`，会话恢复与压缩以本地消息历史为准。

## Alternatives considered

**保持现状：把 reasoning 只当展示数据，把 400 写成已知限制。** 这会让 DeepSeek / Kimi / GLM / Qwen 的带工具思考模式不可用，而这是 Cooper 的主要使用场景。评审已经把它定性为缺陷，不能作为可接受的长期状态。

**把推理文本直接放进 `Message.content`。** 这会污染用户可见的对话、破坏 headless stdout 的“只输出答案”约定，也会让 Anthropic 的 content block 结构无法原样回传。展示和协议必须分开。

**给所有 provider 一个通用的 `reasoning: string`。** 这是旧决策的核心错误。字符串无法表达 Anthropic 的签名和块顺序、OpenRouter 的 `reasoning_details`、Responses 的 `encrypted_content`、Gemini 的 `thoughtSignature`。通用字段只能用于展示，不能用于续传。

**把续传完全留在适配器内部，不改 `Message` / session。** 适配器可以生成 payload，但 loop 不保存、session 不持久化，下一轮或 resume 时 payload 已经不存在；压缩也无法知道哪些消息带 payload。必须让 continuation 成为消息的一部分。

**让 agent loop 感知 vendor 协议，在 loop 里重建消息。** 这违反 `packages/core` 的 provider 抽象和 AGENTS.md 规则 4，也会把两个适配器的细节复制到核心。loop 只应传输和校验，协议细节留在适配器。

**依赖 provider 端状态（`previous_response_id`、Anthropic 服务端压缩）。** 不是所有端点都支持；Cooper 的会话恢复和无状态请求需要客户端自己持有续传数据。可以作为某些适配器的优化，不能作为唯一机制。

**每轮结束后丢弃所有 reasoning，避免持久化。** DeepSeek 在带 `tools` 时要求所有历史轮次回传，丢弃会让第二跳 400；Kimi / GLM 的保留式思考也会失去连续性。不可行。

**继续只持久化 Anthropic 签名块，把未签名 `reasoning_content` 当作展示数据。** “签名”不是协议数据的判据；DeepSeek 的未签名字段同样必须回传。这个例外正是当前 bug 的来源。

**保留 `allowLegacyThinking: true` 作为默认值。** 它会把来源 endpoint/model 不明的 thinking 块发给新的端点，既可能 400，也可能泄露思维链。默认必须是丢弃，legacy 只能显式开启。

**把 continuation 截断或摘要以节省会话体积。** 签名/加密块被截断后无法通过校验，明文 reasoning 被改写也会破坏 DeepSeek / Kimi 的连续性。要节省体积只能删除整条消息或整组，不能裁剪 payload。

## Testing

- `packages/core/test/continuation.test.ts`：canonical JSON 稳定性、`messageAnchor` / `historyAnchor` 对内容变化敏感、`invalidatePrefixContinuations` 保留 message-scope 并标记 prefix/response-scope。
- `packages/core/test/openai-compatible.test.ts`：`reasoning_content` 流式累计、assistant 消息回传、跨 endpoint/model 不重放。
- `packages/core/test/anthropic.test.ts`：完整 `content`（thinking + text + tool_use）原样保存与回放、endpoint/model 不匹配丢弃。
- `packages/core/test/agent.test.ts` 与 `session.test.ts`：continuation 穿过 agent loop、session 和 checkpoint 的 round-trip。
- `apps/cli/test/responses.test.ts`：通过 HTTP SSE 测试端点验证 Responses 工具循环、会话恢复和前缀校验。
- `npm run typecheck` 与 `npm test`：core 155 个测试、CLI 123 个测试全部通过。

## Consequences

这次改动换来了可用的思考工具循环：DeepSeek / Kimi / GLM / Qwen 的 `reasoning_content` 能跨轮续传，Claude 的 thinking 块按原顺序回放，压缩/resume 后不会再把失效签名发给 API，也不会把来源不明的 payload 发到另一个 endpoint。代价是下面这些，均已接受：

**隐私：会话文件会包含明文思维链。** DeepSeek / Kimi / GLM 的续传要求意味着 `reasoning_content` 必须持久化，否则 resume 或跨轮工具循环会断。这是为了可用性付出的代价。只持久化 continuation，不持久化 display reasoning；文档明确会话文件包含模型推理；如果未来要求静态加密，应在 session 层统一做，而不是裁剪 payload。

**成本：续传的 reasoning 会计入输入 token。** DeepSeek 明确说会把历史 `reasoning_content` 拼进上下文；Kimi / GLM 也按输入计费。长工具循环的 token 成本会明显上升。缓解：依赖各模型的 `thinking.keep` / `clear_thinking` 设置；压缩时删除整条旧消息而不是保留其 reasoning；不要把 reasoning 计入摘要请求。不要为了省 token 而裁剪 payload，那会破坏协议。

**Anthropic 压缩后丢弃 thinking 会降低推理连续性。** 这是为了避免 prefix mismatch 400 而接受的代价。模型仍能根据摘要和最近消息继续，但不会延续被丢弃的推理。若未来要保留，需要实现“压缩边界之后的 thinking 仍与新区间自洽”的机制，或使用服务端压缩；不要在客户端把旧块补回。

**provider 差异和严格端点。** 一些 OpenAI 兼容端点可能拒绝输入中的 `reasoning_content`，或只认 `reasoning` / `reasoning_details`。实现只回传该端点实际返回过的字段和字段名；新增适配器要补 wire-level 测试；保留显式的兼容开关，但默认按协议正确处理。

**会话格式兼容。** 旧会话只有 `providerData`，没有 `messageAnchor` / `historyAnchor`；新模型可能拒绝这些块。默认丢弃 legacy 是最安全的，但会让旧会话失去推理连续性；需要在 release note 中说明。

**anchor 计算的性能与稳定性。** 每次请求都要对历史做一次确定性序列化；长会话有 CPU 成本，但相对于模型调用可以忽略。风险在于 canonical 序列化不稳定（例如对象 key 顺序、undefined、浮点数格式）导致误判，从而丢弃本可重放的 payload。`continuation.test.ts` 固定了 canonical 行为。

**payload 体积。** 签名/加密块和长 reasoning 会让 session 文件变大。不能截断 payload；只能通过删除旧消息/整组来控制。需要在 session 层观察文件大小并给出清理策略。

**跨 provider 泄露。** 如果 owner / `messageAnchor` / `historyAnchor` 校验有遗漏，签名 thinking 或加密 reasoning 可能被发到另一个端点。默认 `allowLegacyThinking: false`、严格 protocol/endpoint/model 匹配、跨协议测试是必须的，不能只用“适配器只读自己的 key”这种约定。
