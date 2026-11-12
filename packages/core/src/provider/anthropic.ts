import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import type {
  ContentBlockParam,
  MessageParam,
  TextBlock,
  Tool,
  ToolResultBlockParam,
  ToolUseBlock,
} from "@anthropic-ai/sdk/resources/messages";
import type {
  Message,
  ProviderData,
  ToolCall,
  ToolSpec,
} from "../types.js";
import type {
  ChatRequest,
  Provider,
  ProviderEvent,
  TokenUsage,
} from "./types.js";

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
 * Signed thinking blocks are protocol data: Anthropic requires them to be
 * replayed unchanged with tool results. They are stored in `providerData`,
 * never rendered, and never sent to another provider (AGENTS.md rule 15).
 */
function replayThinking(message: Message, scope?: ThinkingScope): ContentBlockParam[] {
  if (message.role !== "assistant" || message.providerData === undefined) {
    return [];
  }
  const anthropic = message.providerData["anthropic"];
  if (!isRecord(anthropic)) return [];
  if (scope !== undefined) {
    const legacy = anthropic.endpoint === undefined && anthropic.model === undefined;
    const matches = anthropic.endpoint === scope.endpoint && anthropic.model === scope.model;
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

function extractThinking(
  content: readonly Anthropic.ContentBlock[],
): ContentBlockParam[] {
  const blocks: ContentBlockParam[] = [];
  for (const block of content) {
    if (block.type === "thinking") {
      blocks.push({
        type: "thinking",
        thinking: block.thinking,
        signature: block.signature,
      });
    } else if (block.type === "redacted_thinking") {
      blocks.push({ type: "redacted_thinking", data: block.data });
    }
  }
  return blocks;
}

/**
 * Converts the shared message history into Anthropic's request shape:
 *
 *   - leading system messages become the top-level `system` parameter
 *   - assistant text + tool calls become text/tool_use blocks
 *   - consecutive tool results become ONE user message with multiple
 *     tool_result blocks (splitting parallel results breaks tool use)
 */
export function toAnthropicMessages(messages: Message[], scope?: ThinkingScope): {
  system: string | undefined;
  messages: MessageParam[];
} {
  const systemParts: string[] = [];
  const out: MessageParam[] = [];
  let toolResults: ToolResultBlockParam[] = [];

  const flushToolResults = () => {
    if (toolResults.length === 0) return;
    out.push({ role: "user", content: toolResults });
    toolResults = [];
  };

  for (const message of messages) {
    if (message.role === "system") {
      systemParts.push(message.content);
      continue;
    }

    if (message.role === "tool") {
      toolResults.push({
        type: "tool_result",
        tool_use_id: message.toolCallId,
        content: message.content,
      });
      continue;
    }

    flushToolResults();

    if (message.role === "user") {
      out.push({ role: "user", content: message.content });
      continue;
    }

    const content: ContentBlockParam[] = replayThinking(message, scope);
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

    if (content.length > 0) {
      out.push({ role: "assistant", content });
    }
  }

  flushToolResults();

  return {
    system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    messages: out,
  };
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
    this.allowLegacyThinking = options.allowLegacyThinking ?? true;
  }

  async *stream(request: ChatRequest): AsyncIterable<ProviderEvent> {
    const { system, messages } = toAnthropicMessages(request.messages, {
      endpoint: this.endpoint,
      model: request.model,
      allowLegacy: this.allowLegacyThinking,
    });

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
      }
    }

    const message = await stream.finalMessage();
    const content = message.content
      .filter((block): block is TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");

    const toolCalls: ToolCall[] = message.content
      .filter((block): block is ToolUseBlock => block.type === "tool_use")
      .map((block) => ({
        id: block.id,
        name: block.name,
        arguments: JSON.stringify(block.input ?? {}),
      }));

    const thinking = extractThinking(message.content);
    const providerData: ProviderData | undefined =
      thinking.length > 0
        ? { anthropic: { thinking, endpoint: this.endpoint, model: request.model } }
        : undefined;

    yield {
      type: "done",
      message: {
        content,
        toolCalls,
        ...(providerData !== undefined ? { providerData } : {}),
      },
      finishReason: message.stop_reason,
      usage: toUsage(message.usage),
    };
  }
}
