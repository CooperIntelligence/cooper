# Agent Note: Provider Routes, Not Wire Protocols, Key the LLM Adapter

Status: proposed

## Problem

Cooper 现在把 `protocol` 当作连接的第一分类：`apps/cli/src/settings.ts:17` 只接受
`openai-chat` / `anthropic-messages` / `openai-responses`，`apps/cli/src/config.ts:29`
把它和 model、baseURL、apiKey 并列为必填连接字段，`apps/cli/src/provider.ts:23-42`
用三个 `if` 选适配器。厂商在这一层不可见。

但真正的错不在“选了 protocol”，而在**把 protocol 当成有约束力的契约**。协议只是
序列化语法：它规定 JSON 长什么样，不规定哪些字段必须一起出现、哪些顺序不能动、
哪些组合会被拒绝。校验发生在端点侧，而且各家的校验规则不同：

- DeepSeek 的 Messages 入口忽略 `budget_tokens`，思考强度走
  `output_config.effort`，而 Anthropic 原生 Messages 用 `budget_tokens`；
- Kimi 的 Chat 入口用 `thinking.keep` 控制跨轮保留；
- GLM 的 Chat 入口用 `clear_thinking: false` 开启 Preserved Thinking，要求完整、
  未修改、保序回传 `reasoning_content`；
- Qwen 的 Chat 入口在 agent 场景要求 `preserve_thinking`；
- OpenRouter 用结构化的 `reasoning_details` 数组，还叠加网关自己的 provider
  routing 与 transforms；
- Azure 需要 `api-version` 和 deployment 路径，字段名也与官方不同。

这些不是“同一个契约的几个开关”，而是各自一套请求构造规则。把它们塞进一个共享
适配器、再用 profile 布尔去区分，会得到一个事实上的影子适配器：每个厂商的规则
都被重新编码成条件分支，组合起来无法穷举，也无法按厂商测试。

Cooper 的现状已经展示了这个失败的形态：
`packages/core/src/provider/openai-compatible.ts:219-247` 靠嗅探猜 reasoning
字段名，`:107-112` 用 400 文本匹配 `stream_options`，`:143` 把学习结果记成进程
级布尔；`packages/core/src/context/window.ts:12-45` 用模型名正则猜上下文窗口。
差异只能以“发过一次 400”的形式存在。

结论：第一分类必须是**谁在校验**，也就是厂商/端点这套服务契约；协议是这套契约
的实现细节，不是分类维度。

## Proposal

### 决策

引入 **provider route** 作为连接的第一身份，每个 route 对应一个**厂商适配器**，
而不是一个按协议分叉的通用适配器。route 绑定适配器、凭据、端点、模型目录和
模型能力；wire protocol 由适配器实现，不出现在配置里。

请求解析顺序：

1. `provider` 选中 route；
2. route 选中该厂商的适配器；
3. 适配器决定 protocol、请求构造、字段规则、流式解析和错误分类；
4. 模型能力（上下文窗口、模态、reasoning 回传要求）由 route 的模型条目声明，
   用户配置可覆盖。

### 厂商与协议现状

本次核对的结果（空白表示官方文档中未见到，不代表不存在）：

| 厂商 | Chat Completions | Responses | Anthropic Messages | 原生接口 |
|---|---|---|---|---|
| OpenAI | ✓ | ✓（主推） | | Responses |
| Anthropic | | | ✓ | Messages |
| Google Gemini | ✓（兼容层） | | | generateContent |
| DeepSeek | ✓ | ✓ | ✓ | |
| Kimi / Moonshot | ✓ | ✓ | ✓ | |
| Z.ai / GLM | ✓ | ✓ | ✓ | |
| Qwen / DashScope | ✓ | | ✓ | DashScope |
| OpenRouter | ✓ | ✓ | ✓ | |
| Azure OpenAI | ✓ | ✓（v1 Responses） | | |
| Xiaomi MiMo | ✓ | | ✓ | |
| MiniMax | ✓ | | ✓（官方推荐） | |

两个事实决定了范围：

1. **OpenAI Chat Completions 是事实上的通用基线**，几乎所有厂商都提供。
2. **Anthropic Messages 是 agent 场景的第二条通用路径**：Anthropic 原生，DeepSeek、
   Kimi、GLM、Qwen、Xiaomi、MiniMax、OpenRouter 都提供兼容端点，因为 Claude Code
   生态在用。Responses 正在扩散（OpenAI、Azure、Kimi、GLM、OpenRouter），但还不是
   通用层。

### 支持范围

**协议族做三个：`openai-chat`、`anthropic-messages`、`openai-responses`。**
不做 Gemini 原生 `generateContent`：它只有 Google 一家，而 Google 提供 OpenAI
兼容层，够覆盖基本对话与工具；缺的是 thought signature 的原样续传。重新引入的
条件：Google 用户需要跨轮工具调用且签名续传成为硬需求时，再加 `gemini` codec 和
`GoogleAdapter` 的原生实现。

**0.2.0 名单是发布模型的厂商，不含中转站**（OpenRouter、OpenCode、CommandCode
走 `custom-*`，不单独做）：

| 批次 | route | 适配器 | 理由 |
|---|---|---|---|
| P0 | `deepseek` | 专属 | Messages、effort、工具轮续传、Files |
| P0 | `openai` | 已有 Responses 实现 | 原生 Responses 与 encrypted reasoning |
| P0 | `anthropic` | 已有 Messages 实现 | 签名 thinking、prefix 绑定 |
| P0 | `kimi` | 专属 | `thinking.keep`、Messages 端点细节 |
| P0 | `minimax` | 通用 Messages | 官方推荐 Anthropic 路径，暂未见结构性差异 |
| P1 | `zhipu` | 通用 Messages → 观察 | `clear_thinking`、交错块；出现结构差异就升级 |
| P1 | `qwen` | 通用 Messages → 观察 | 兼容层较新，thinking 语义待核对 |
| P1 | `xiaomi` | 通用 Messages | 官方双协议，文档推荐 Anthropic 路径 |

通用适配器按协议分两个实现（`GenericMessagesAdapter`、`GenericOpenAIAdapter`），
每个 route 一个实例、一份 profile；route 到适配器的绑定是数据，发现结构性差异时
换实现只改一行。判据：

| 差异类型 | 处理 |
|---|---|
| 请求构造、字段共现、消息/块顺序、replay 语义 | 专属适配器 |
| 端点、模型目录、上下文窗口、模态、能力布尔 | 通用适配器 + profile |

计费模式、套餐、区域**不是路由维度**：MiniMax 的 `.io` / `.cn`、Xiaomi 的按量付费
与 Token Plan 只是 host 和 key 前缀不同，用一个 route 加 `baseURL` 覆盖即可。

### 各家主推与特殊要求

默认模型是目录数据，不是代码常量；下表给示例值，以官方目录为准。

| route | 主协议 | 端点 | 默认模型（示例） | 特殊要求 |
|---|---|---|---|---|
| `deepseek` | `anthropic-messages` | `https://api.deepseek.com/anthropic` | `deepseek-v4-pro`（备选 `deepseek-flash`） | `output_config.effort`；`budget_tokens` 忽略；`redacted_thinking` 不支持；**续接 `tool_result` 时原样回传对应 assistant 的完整 `content`（thinking + tool_use）**，省略会触发服务端恢复，恢复失败即 400 |
| `openai` | `openai-responses` | `https://api.openai.com/v1` | `gpt-5` 系列（示例 `gpt-5.2`） | `store: false` + `include: ["reasoning.encrypted_content"]`；`max_output_tokens`；strict tool schema |
| `anthropic` | `anthropic-messages` | `https://api.anthropic.com` | Claude 5 系列（示例 `claude-sonnet-5`） | thinking 块带签名；前缀绑定；`tool_result` 必须紧跟 `tool_use` 且在前 |
| `kimi` | `anthropic-messages` | `https://api.moonshot.cn/anthropic` | `kimi-k3.1-pro` | Messages 端点：thinking 块随 `tool_use` 回传（待核对）；同时提供 Chat 与 Responses 入口，本期只实现 Messages |
| `zhipu` | `anthropic-messages` | `https://api.z.ai/api/anthropic` | `glm-5.3` | Messages 端点：thinking 块随 `tool_use` 回传（待核对）；Chat 入口的 `clear_thinking` 不属于本期契约 |
| `qwen` | `anthropic-messages` | `https://{WorkspaceId}.{region}.maas.aliyuncs.com/apps/anthropic`（以控制台为准） | `qwen3.7-plus` | Messages 端点：thinking 块随 `tool_use` 回传（待核对）；Chat 入口的 `preserve_thinking` 不属于本期契约；区域与工作空间域名可覆盖 |
| `xiaomi` | `anthropic-messages` | `https://api.xiaomimimo.com/anthropic` | `mimo-v2.6-pro` | Messages 端点：thinking 块（待核对）；`api-key` 头需实测；`max_completion_tokens` 只与 Chat 入口相关 |
| `minimax` | `anthropic-messages` | `https://api.minimax.io/anthropic` | `MiniMax-M3.1-Flash` | Messages 端点：thinking 块 + 交错思考；中国区换 `.cn`；签名待核对 |

OpenAI 与 Anthropic 的主推协议是它们各自的原生接口；其余六家的主协议都选
Messages，因为那是它们的 agent 路径（Claude Code 同款），thinking 与工具续传的
语义最接近原生。Chat 作为回退，藏在适配器里，不暴露给用户。

### 思维链契约

每家必须回答四个问题：**回传什么形态、什么时候必须回传、加密还是签名、怎么展示。**

| route | 回传形态 | 何时必须回传 | 加密 / 签名 | 展示 |
|---|---|---|---|---|
| `anthropic` | `thinking` / `redacted_thinking` 块 | 返回 `tool_result` 时随 `tool_use` 原样回传；前缀绑定 | 明文 thinking 带签名；`redacted_thinking` 为不透明密文 | 明文块可展示；redacted 显示占位符 |
| `openai` | reasoning item（`encrypted_content`） | `store: false` 的下一轮按原顺序放回 `input` | 加密；可请求 summary | 只展示 summary；密文永不展示 |
| `deepseek` | `thinking` 块 + `tool_use`（Messages） | **调用级**：请求续接 `tool_result` 时，对应 assistant 的完整 `content` 必须原样回传；省略会触发服务端按 tool call id 恢复，恢复失败即 400 | 明文；`redacted_thinking` 不支持；签名可为空，原样回传 | 明文展示 |
| `kimi` | `thinking` 块（待核对） | 续接 `tool_result` 时回传完整 `content`（按 Messages 语义） | 明文（签名待核对） | 明文展示 |
| `zhipu` | `thinking` 块（待核对） | 续接 `tool_result` 时回传完整 `content`（按 Messages 语义） | 明文 | 明文展示 |
| `qwen` | `thinking` 块（待核对） | 续接 `tool_result` 时回传完整 `content`（按 Messages 语义） | 明文 | 明文展示 |
| `xiaomi` | `thinking` 块（待核对） | 续接 `tool_result` 时回传完整 `content`（按 Messages 语义） | 明文 | 明文展示 |
| `minimax` | `thinking` 块 | 续接 `tool_result` 时回传完整 `content`（交错思考） | 明文（签名待核对） | 明文展示 |

表里只写本期选定协议的规则。`reasoning_content`、`clear_thinking`、
`preserve_thinking`、`thinking.keep` 都是各家 Chat 入口文档里的概念，本期契约不
使用；它们 Messages 入口的实际形态在联调时核对后回填，不按 Chat 文档推断。

每条 route 只按它选定的协议写规则，不要把另一个兼容入口的要求搬过来。

- **`deepseek`（Messages）：调用级。** 请求续接 `tool_result` 时，对应 assistant
  的完整 `content`（thinking + tool_use）必须原样回传；没有待续接工具结果的轮次
  不强制。省略会触发服务端恢复，恢复失败即 400。
- **`anthropic`（Messages）：调用级 + 前缀绑定。** 返回 `tool_result` 时随
  `tool_use` 回传 thinking；新模型还要求历史 append-only。
- **`openai`（Responses）：响应级。** `store: false` 时，下一个请求必须把上一轮
  的 reasoning item 按原顺序放进 `input`。

`VendorContract.reasoning.required` 用 `"never" | "with-tool-use" | "always"`
表达。不要引入 `"with-tools"` 这种跨协议的判据：那是另一个兼容入口的规则，
本期不做；以后真要给某家加第二个入口，那是新的 route 和新契约，届时单独研究。

四类数据的边界（沿用 [2026-11-12](../../implemented/architecture/2026-11-12-reasoning-continuation-replay.md)）：

1. **display reasoning**：`reasoning-delta` 事件，只在当前进程展示；`--show-reasoning`
   写 stderr；永不进入 `messages`、会话文件、headless stdout。
2. **continuation**：跨轮重放所需的原始 payload；进入 `Message.continuation`，
   随会话持久化；只回放给同一 route / protocol / endpoint / model。
3. **加密或签名块**：属于 continuation，永远不当作展示文本；OpenAI 的密文、
   Anthropic 的 redacted 块都属于这一类。
4. **summary**：OpenAI Responses 的 reasoning summary 是可展示的派生文本，
   不能当 continuation 回传。

### 契约怎么写

适配器声明一份数据，而不是散落的 `if`：

```ts
type VendorContract = {
  route: string;
  protocol: "anthropic-messages" | "openai-chat" | "openai-responses";
  endpoint: string;
  defaultModel: string;
  auth: { header: "authorization" | "api-key"; scheme: "bearer" | "raw" };
  request: { maxTokensField: "max_tokens" | "max_completion_tokens" | "max_output_tokens" };
  reasoning: {
    shape: "thinking-blocks" | "reasoning-items" | "none";
    required: "never" | "with-tool-use" | "always";
    encrypted: boolean;
    signed: boolean;
    display: "plaintext" | "summary" | "none";
  };
};
```

规则：**能用这份数据表达的差异，留在 profile；一旦需要代码才能表达（字段共现、
顺序、回放算法、错误映射），就升成专属适配器。** 这份数据也是 `/status` 展示
能力来源的依据。

### 适配器拥有什么

请求字段的出现与省略、必须同时出现的字段、消息与内容块顺序、流式增量形态、
工具调用拼接、错误分类与可重试性、reasoning 回传策略。换句话说，**厂商规则就是
适配器代码**，不是一张开关表。

### 共享 codec 不是 Provider

去重靠内部工具层，而不是靠一个“通用适配器”：

- 共享：SSE 分帧、工具调用增量拼接、usage 解析、canonical JSON 与哈希、角色
  映射这些与厂商无关的机械部分。
- 不共享：请求构造策略、字段规则、replay 策略、错误到可重试性的映射。
- 纪律：共享层里不允许出现厂商分支；适配器里允许出现任何厂商分支。

这与 `AGENTS.md` 规则 4 不冲突：规则要求的是 agent loop 不感知厂商、新 provider
实现 `Provider` 接口，**没有**要求一个适配器必须服务所有厂商。

### 模型能力与配置

route 的模型条目只声明模型级事实：上下文窗口、最大输出、输入模态、reasoning
回传要求、system prompt 位置。这些是数据，可以有配置覆盖；但它们不用来表达请求
构造逻辑。

```json
{
  "provider": "deepseek",
  "model": "deepseek-v4-pro",
  "apiKey": "...",
  "baseURL": "https://api.deepseek.com/anthropic",
  "maxOutputTokens": 64000
}
```

`protocol` 保留为废弃别名，映射到 `custom-*` / `openai-responses`，并产生警告。
配置仍然只有一个来源、一次整体写回
（[2026-11-11](../../implemented/architecture/2026-11-11-single-provider-configuration-source.md)）。

### Continuation 归属

`Continuation` 增加可选 `route`。校验顺序：`route` 存在且不同则丢弃 → `protocol`
/ `endpoint` / `model` 匹配 → anchor 匹配。缺 `route` 的旧 payload 回落到现有三元组
校验（[2026-11-12](../../implemented/architecture/2026-11-12-reasoning-continuation-replay.md)
的 scope 与 anchor 规则不变）。

## Alternatives considered

**保留 `protocol` 作第一键，按厂商加 `if` 和嗅探。** 这是现状。它丢掉的是可声明性
和可测试性：差异只能以“发过一次 400”的形式存在，首次请求仍然是盲的；共享适配器
里的事实分支让 protocol 这个分类名不副实。

**单一通用适配器加能力 profile（本提案的初稿）。** 这是最像“正确抽象”的方案，
也是我最初写进这份笔记的方案：五家厂商共用一个 `OpenAICompatibleProvider`，差异
用 `reasoningReplay`、`supportsStreamOptions` 之类的字段表达。它错在把结构性差异
当成了开关：profile 无法表达“有 tools 时才逐轮回传”“块必须保序”“字段必须同时
出现”。当开关多到需要互相约束时，它已经是一个影子适配器，只是没有适配器的测试
边界。

**每厂商复制一份完整适配器。** 重复太多，且会把 SSE 拼接、usage 解析这类机械
代码复制 N 份。最终采用“厂商适配器 + 共享 codec”：厂商规则在适配器里，机械代码
在共享层。

**四种协议全做，每个厂商都做。** 适配器数量是厂商数乘协议数，维护成本是平方级；
厂商的兼容层已经吸收了一部分协议差异，我们真正需要自有实现的是“agent 路径 +
续传语义”，不是每个 wire 形状。Gemini 原生因此缓做，中转站因此不做。

**增加 `backend` 作为第三维。** DSH 明确拒绝过：同一上游的不同实现是部署期选择，
不是运行时维度。

**从 `baseURL` 自动识别厂商。** 网关、代理、自建端点都会让识别失败，而失败是
静默的。显式 `provider` 加 `custom-*` 兜底比猜更诚实。

## Acceptance criteria

- 每个 P0 route 有独立适配器文件；适配器内允许厂商分支，共享 codec 内不允许。
- 每条 route 有来自厂商文档的 wire fixture：reasoning 回传字段与时机、字段必须
  同时出现的组合、消息顺序、`stream_options`、max tokens 字段名、tool schema 形态。
- `custom-*` 适配器在 README 与 `/status` 中标注实验性，并列出已知限制。
- P1 厂商在文档中标注“通用适配器，待核对项”，不静默伪装成已完全支持。
- `usageSupported` 运行时布尔移除；同类兜底只作为最后手段，写回 route 配置并
  只 warn 一次。
- 上下文窗口与最大输出的来源出现在 `/status`（config / model entry / default）。
- `Continuation` 带 `route`；跨 route 重放测试 fail closed；缺 `route` 的旧 payload
  按 protocol + endpoint + model 重放。
- 旧 `config.json` 迁移测试：protocol 到 route 的映射正确、警告存在、其余字段不丢。
- onboarding、config-editor、README、`AGENTS.md` 同步；`npm run typecheck` 与
  `npm test` 通过。

## Risks

- **名单外的覆盖缺口。** 用户会问“为什么没有 Google / xAI”。缓解：`custom-*` 兜底；
  文档列出缓做条件；中转站走 custom。
- **待核对项变成 400。** Xiaomi 的 `api-key` 头、MiniMax 与 Kimi 的签名、Qwen 的
  `preserve_thinking` 语义，都需要联调确认。缓解：实现前逐个做最小请求验证，
  结论回写本笔记的表格；不要按文档猜。
- **适配器数量增加。** 每个厂商一个文件。缓解：共享 codec 吸收机械代码；适配器只
  写该厂商的规则；wire fixture 让规则可回归。
- **厂商规则漂移。** 文档变化后适配器会过期。缓解：适配器顶部记录来源链接与最后
  核对日期；fixture 用录制响应；issue 模板要求附厂商文档链接。
- **`custom-*` 的假承诺。** 用户会以为任意兼容端点都能用。缓解：标注实验性与已知
  限制，错误信息指到具体字段，不承诺“不会 400”。
- **迁移面大。** `protocol` 出现在 settings、config、provider、onboarding、
  config-editor、status、README 和测试里。缓解：别名加迁移测试，分两步发布。
