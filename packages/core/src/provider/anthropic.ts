import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import type {
  ContentBlockParam,
  MessageParam,
  TextBlock,
  Tool,
  ToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/messages";
import type { Message, ToolCall, ToolSpec } from "../types.js";
import type {
  ChatRequest,
  Provider,
  ProviderEvent,
  TokenUsage,
} from "./types.js";
import {
  canonicalJson,
  extendHistoryHash,
  hashAssistantFields,
  historySeed,
  matchesOwner,
  type Continuation,
} from "./continuation.js";

export type AnthropicProviderOptions = {
  apiKey: string;
  /** Base URL without the /v1 suffix, matching the SDK's `baseURL`. */
  baseURL?: string;
  /** Streaming responses let us give the model room without HTTP timeouts. */
  maxTokens?: number;
  /** Allow replay of older session data whose originating endpoint is unknown. */
  allowLegacyThinking?: boolean;
  /** Injectable client, used by tests; the constructor builds one otherwise. */
  client?: Anthropic;
};

const DEFAULT_MAX_TOKENS = 64_000;

/**
 * Models that accept `thinking: {type: "adaptive"}`. Older families use a
 * fixed budget (or no thinking at all), so the parameter is omitted for them.
 */
export function supportsAdaptiveThinking(model: string): boolean {
  return (
    /^claude-(fable|mythos|opus|sonnet|haiku)-5(?:[.\-[]|$)/i.test(model) ||
    /^claude-(opus|sonnet)-4[-.][678](?:[.\-[]|$)/i.test(model)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseToolInput(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed ?? {};
  } catch {
    // The agent will fail the call when it validates the input. The provider
    // still needs a valid object so the assistant turn can be replayed.
    return {};
  }
}

type ThinkingScope = {
  endpoint: string;
  model: string;
  allowLegacy: boolean;
};

/**
 * Legacy path for session files written before `Message.continuation`: signed
 * thinking blocks used to live under `providerData.anthropic.thinking`. New
 * code never writes this shape; it is only read when the caller explicitly
 * allows legacy data.
 */
function replayLegacyThinking(
  message: Message,
  scope?: ThinkingScope,
): ContentBlockParam[] {
  if (message.role !== "assistant" || message.providerData === undefined) {
    return [];
  }
  const anthropic = message.providerData["anthropic"];
  if (!isRecord(anthropic)) return [];
  if (scope !== undefined) {
    const legacy =
      anthropic.endpoint === undefined && anthropic.model === undefined;
    const matches =
      anthropic.endpoint === scope.endpoint && anthropic.model === scope.model;
    if (!matches && !(legacy && scope.allowLegacy)) return [];
  }
  const blocks = anthropic["thinking"];
  if (!Array.isArray(blocks)) return [];

  const out: ContentBlockParam[] = [];
  for (const block of blocks) {
    if (!isRecord(block)) continue;
    if (
      block.type === "thinking" &&
      typeof block.thinking === "string" &&
      typeof block.signature === "string"
    ) {
      out.push({
        type: "thinking",
        thinking: block.thinking,
        signature: block.signature,
      });
    } else if (
      block.type === "redacted_thinking" &&
      typeof block.data === "string"
    ) {
      out.push({ type: "redacted_thinking", data: block.data });
    }
  }
  return out;
}

function payloadContent(
  continuation: Continuation,
  message: Extract<Message, { role: "assistant" }>,
): ContentBlockParam[] | null {
  if (!isRecord(continuation.payload)) return null;
  const content = continuation.payload["content"];
  if (!Array.isArray(content)) return null;
  if (!content.every(isRecord)) return null;
  const blocks = content as unknown as ContentBlockParam[];

  // The payload must describe the same visible message. A mismatch means a
  // corrupted or hand-edited continuation; rebuild from the visible fields
  // instead of sending a different assistant turn than the UI shows.
  const toolUseIds = blocks
    .filter((block) => block.type === "tool_use")
    .map((block) => block.id);
  const calls = message.toolCalls ?? [];
  if (
    toolUseIds.length !== calls.length ||
    toolUseIds.some((id, index) => id !== calls[index]?.id)
  ) {
    return null;
  }
  const callsById = new Map(calls.map((call) => [call.id, call]));
  for (const block of blocks) {
    if (block.type !== "tool_use") continue;
    const call = callsById.get(block.id);
    if (call === undefined) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(call.arguments);
    } catch {
      return null;
    }
    if (canonicalJson(block.input) !== canonicalJson(parsed)) return null;
  }
  const text = blocks
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  if (text !== message.content) return null;

  return blocks;
}

/**
 * Converts the shared message history into Anthropic's request shape:
 *
 *   - leading system messages become the top-level `system` parameter
 *   - assistant text + tool calls become text/tool_use blocks
 *   - consecutive tool results become ONE user message with multiple
 *     tool_result blocks (splitting parallel results breaks tool use)
 *
 * The function also maintains the rolling hash of the exact wire prefix. A
 * continuation is only replayed when its `historyAnchor` matches that hash;
 * any edit before the assistant message (compaction, a regenerated system
 * prompt, a changed tool list) therefore drops the stale thinking blocks
 * instead of letting them reach the API.
 */
export function toAnthropicMessages(
  messages: Message[],
  scope?: ThinkingScope,
  tools: ToolSpec[] = [],
): {
  system: string | undefined;
  messages: MessageParam[];
  historyHash: string;
} {
  const systemParts: string[] = [];
  for (const message of messages) {
    if (message.role === "system") systemParts.push(message.content);
  }
  const system =
    systemParts.length > 0 ? systemParts.join("\n\n") : undefined;

  const out: MessageParam[] = [];
  let toolResults: ToolResultBlockParam[] = [];
  let historyHash = historySeed(system, tools);

  const pushWire = (wire: MessageParam) => {
    out.push(wire);
    historyHash = extendHistoryHash(historyHash, wire);
  };

  const flushToolResults = () => {
    if (toolResults.length === 0) return;
    const wire: MessageParam = { role: "user", content: toolResults };
    toolResults = [];
    pushWire(wire);
  };

  for (const message of messages) {
    if (message.role === "system") continue;

    if (message.role === "tool") {
      toolResults.push({
        type: "tool_result",
        tool_use_id: message.toolCallId,
        content: message.content,
        ...(message.isError === true ? { is_error: true } : {}),
      });
      continue;
    }

    flushToolResults();

    if (message.role === "user") {
      pushWire({ role: "user", content: message.content });
      continue;
    }

    const continuation = message.continuation;
    const payload =
      continuation !== undefined &&
      continuation.protocol === "anthropic-messages" &&
      continuation.scope === "prefix" &&
      continuation.messageAnchor ===
        hashAssistantFields(message.content, message.toolCalls)
        ? payloadContent(continuation, message)
        : null;
    const exact =
      payload !== null &&
      continuation !== undefined &&
      continuation.stale !== true &&
      (scope === undefined ||
        matchesOwner(continuation, {
          protocol: "anthropic-messages",
          endpoint: scope.endpoint,
          model: scope.model,
        })) &&
      continuation.historyAnchor !== undefined &&
      continuation.historyAnchor === historyHash;

    let content: ContentBlockParam[];
    if (exact && payload !== null) {
      // Echo the assistant turn exactly as it was received. Do not merge text,
      // move thinking blocks, reorder tool_use, or filter redacted_thinking.
      content = payload;
    } else if (payload !== null) {
      // The protocol is the same but the prefix/model changed (compaction,
      // resume, model switch). Keep the visible blocks exactly as received and
      // drop only the stale thinking blocks; rebuilding the message would lose
      // block order.
      content = payload.filter(
        (block) => block.type !== "thinking" && block.type !== "redacted_thinking",
      );
    } else {
      content =
        scope === undefined || scope.allowLegacy
          ? replayLegacyThinking(message, scope)
          : [];
      if (message.content.length > 0) {
        content.push({ type: "text", text: message.content });
      }
      for (const call of message.toolCalls ?? []) {
        content.push({
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: parseToolInput(call.arguments),
        });
      }
    }

    if (content.length > 0) {
      pushWire({ role: "assistant", content });
    }
  }

  flushToolResults();

  return { system, messages: out, historyHash };
}

export function toAnthropicTools(tools: ToolSpec[]): Tool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters as Tool.InputSchema,
  }));
}

function toUsage(usage: Anthropic.Usage | undefined): TokenUsage | undefined {
  if (usage === undefined) return undefined;
  return {
    // Cache reads/writes are still prompt tokens; include them so context
    // calibration reflects the whole request.
    inputTokens:
      usage.input_tokens +
      (usage.cache_creation_input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0),
    outputTokens: usage.output_tokens,
  };
}

/**
 * Anthropic Messages API adapter. Normalizes streaming events into the shared
 * ProviderEvent shape so the agent loop stays vendor-agnostic.
 */
export class AnthropicProvider implements Provider {
  private readonly client: Anthropic;
  private readonly maxTokens: number;
  private readonly endpoint: string;
  private readonly allowLegacyThinking: boolean;

  constructor(options: AnthropicProviderOptions) {
    this.client =
      options.client ??
      new Anthropic({
        apiKey: options.apiKey,
        baseURL: options.baseURL,
      });
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.endpoint = createHash("sha256").update(this.client.baseURL).digest("hex");
    // Default must be fail-closed: a block whose origin is unknown could
    // otherwise be replayed to a different endpoint, which is both a protocol
    // error and a chain-of-thought leak.
    this.allowLegacyThinking = options.allowLegacyThinking ?? false;
  }

  protectedToolHistoryLength(request: ChatRequest): number {
    const { messages, model } = request;
    const latest = messages.findLastIndex((message) => message.role === "assistant");
    if (latest < 0 || messages[latest + 1]?.role !== "tool") return 0;

    // A tool round can contain several assistant/tool exchanges. Earlier
    // thinking in that round also has to survive until Claude finishes it.
    for (let index = latest; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.role !== "assistant") continue;
      if (!message.toolCalls?.length) break;
      const state = message.continuation;
      if (
        state?.scope === "prefix" && !state.stale && state.historyAnchor !== undefined &&
        matchesOwner(state, { protocol: "anthropic-messages", endpoint: this.endpoint, model }) &&
        state.messageAnchor === hashAssistantFields(message.content, message.toolCalls) &&
        payloadContent(state, message)?.some((block) =>
          (block.type === "thinking" && Boolean(block.signature)) || block.type === "redacted_thinking")
      ) {
        return latest + 1;
      }
    }
    return 0;
  }

  async *stream(request: ChatRequest): AsyncIterable<ProviderEvent> {
    const { system, messages, historyHash } = toAnthropicMessages(
      request.messages,
      {
        endpoint: this.endpoint,
        model: request.model,
        allowLegacy: this.allowLegacyThinking,
      },
      request.tools,
    );

    const params: Anthropic.MessageStreamParams = {
      model: request.model,
      max_tokens: this.maxTokens,
      messages,
      ...(system !== undefined ? { system } : {}),
      ...(request.tools.length > 0
        ? { tools: toAnthropicTools(request.tools) }
        : {}),
      // Summarized display makes --show-reasoning useful; thinking itself is
      // on by default on these models and unrelated to display.
      ...(supportsAdaptiveThinking(request.model)
        ? { thinking: { type: "adaptive" as const, display: "summarized" as const } }
        : {}),
    };

    const stream = this.client.messages.stream(params, {
      signal: request.signal,
    });
    const toolInputDeltas = new Map<number, string>();

    for await (const event of stream) {
      if (event.type === "content_block_start") {
        // Some models seed the thinking block with text before the deltas.
        if (
          event.content_block.type === "thinking" &&
          event.content_block.thinking.length > 0
        ) {
          yield { type: "reasoning", delta: event.content_block.thinking };
        }
        continue;
      }

      if (event.type !== "content_block_delta") continue;
      if (event.delta.type === "text_delta") {
        yield { type: "text", delta: event.delta.text };
      } else if (event.delta.type === "thinking_delta") {
        yield { type: "reasoning", delta: event.delta.thinking };
      } else if (event.delta.type === "input_json_delta") {
        toolInputDeltas.set(event.index, (toolInputDeltas.get(event.index) ?? "") + event.delta.partial_json);
      }
    }

    const message = await stream.finalMessage();
    const content = message.content
      .filter((block): block is TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");

    const toolCalls: ToolCall[] = [];
    for (const [index, block] of message.content.entries()) {
      if (block.type !== "tool_use") continue;
      if (message.stop_reason !== "tool_use") {
        throw new Error(`Anthropic Messages returned an unfinished tool call (stop_reason: ${message.stop_reason}).`);
      }
      const rawInput = toolInputDeltas.get(index);
      // The SDK exposes a partially parsed object during streaming. Check the
      // original JSON so an incomplete argument cannot silently become `{}`.
      let input: unknown;
      try {
        input = rawInput ? JSON.parse(rawInput) : block.input;
      } catch {
        throw new Error("Anthropic Messages returned malformed tool arguments.");
      }
      if (!isRecord(input) || !block.id.trim() || !block.name.trim()) {
        throw new Error("Anthropic Messages returned an incomplete tool call.");
      }
      toolCalls.push({ id: block.id, name: block.name, arguments: JSON.stringify(input) });
    }
    if (message.stop_reason === "tool_use" && (
      toolCalls.length === 0 || new Set(toolCalls.map((call) => call.id)).size !== toolCalls.length
    )) {
      throw new Error("Anthropic Messages returned missing or duplicate tool calls.");
    }

    // Store the complete ordered content, not just the thinking blocks. The
    // next request must echo text/thinking/tool_use exactly as received.
    const truncated = message.stop_reason === "max_tokens" || message.stop_reason === "model_context_window_exceeded";
    const continuation: Continuation | undefined =
      !truncated && message.content.length > 0
        ? {
            protocol: "anthropic-messages",
            endpoint: this.endpoint,
            model: request.model,
            scope: "prefix",
            messageAnchor: hashAssistantFields(content, toolCalls),
            historyAnchor: historyHash,
            payload: { content: message.content },
          }
        : undefined;

    yield {
      type: "done",
      message: {
        content,
        toolCalls,
        ...(continuation !== undefined ? { continuation } : {}),
      },
      finishReason: message.stop_reason,
      usage: toUsage(message.usage),
    };
  }
}
