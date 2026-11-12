import { createHash } from "node:crypto";
import OpenAI from "openai";
import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import type { Message, ToolCall } from "../types.js";
import type {
  ChatRequest,
  Provider,
  ProviderEvent,
  TokenUsage,
} from "./types.js";
import {
  hashAssistantFields,
  type Continuation,
  type ContinuationOwner,
} from "./continuation.js";

export type OpenAICompatibleOptions = {
  apiKey: string;
  /** Base URL without the /chat/completions suffix. */
  baseURL?: string;
  headers?: Record<string, string>;
};

type OpenAIReasoningPayload = {
  field?: "reasoning_content" | "reasoning";
  reasoningContent?: string;
  reasoningDetails?: unknown[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Builds the wire messages. An assistant message replays its continuation only
 * when the protocol, endpoint, model, and visible message still match. This is
 * what keeps a resumed session from sending one endpoint's reasoning to
 * another endpoint.
 */
export function toOpenAIMessages(
  messages: Message[],
  owner?: ContinuationOwner,
): ChatCompletionMessageParam[] {
  return messages.map((message): ChatCompletionMessageParam => {
    switch (message.role) {
      case "system":
        return { role: "system", content: message.content };
      case "user":
        return { role: "user", content: message.content };
      case "assistant": {
        const result: ChatCompletionAssistantMessageParam = {
          role: "assistant",
          content: message.content || null,
        };
        if (message.toolCalls?.length) {
          result.tool_calls = message.toolCalls.map((call) => ({
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: call.arguments },
          }));
        }

        const continuation = message.continuation;
        if (
          owner !== undefined &&
          continuation !== undefined &&
          continuation.stale !== true &&
          continuation.protocol === "openai-chat" &&
          continuation.endpoint === owner.endpoint &&
          continuation.model === owner.model &&
          continuation.messageAnchor ===
            hashAssistantFields(message.content, message.toolCalls)
        ) {
          const payload = isRecord(continuation.payload)
            ? (continuation.payload as OpenAIReasoningPayload)
            : undefined;
          if (typeof payload?.reasoningContent === "string" && payload.reasoningContent.length > 0) {
            const field =
              payload.field === "reasoning" ? "reasoning" : "reasoning_content";
            (result as unknown as Record<string, unknown>)[field] =
              payload.reasoningContent;
          }
          if (
            Array.isArray(payload?.reasoningDetails) &&
            payload.reasoningDetails.length > 0
          ) {
            (result as unknown as Record<string, unknown>).reasoning_details =
              payload.reasoningDetails;
          }
        }
        return result;
      }
      case "tool":
        return {
          role: "tool",
          tool_call_id: message.toolCallId,
          content: message.content,
        };
    }
  });
}

/** Some OpenAI-compatible endpoints reject unknown request fields. */
function rejectsStreamOptions(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const status = (error as { status?: number }).status;
  if (status !== undefined && status !== 400 && status !== 422) return false;
  return /stream_options|include_usage/i.test(error.message);
}

/**
 * OpenRouter and some gateways send structured reasoning as an array of
 * blocks. Streaming deltas may carry an `index`; merge by index when present,
 * otherwise append. The array is replayed verbatim, so preserving its order is
 * required.
 */
function mergeReasoningDetails(target: unknown[], incoming: unknown): void {
  if (!Array.isArray(incoming)) return;
  for (const part of incoming) {
    if (isRecord(part) && typeof part.index === "number") {
      const index = part.index;
      const existing = target[index];
      target[index] =
        isRecord(existing) && isRecord(part)
          ? { ...existing, ...part }
          : part;
    } else {
      target.push(part);
    }
  }
}

/**
 * Works with OpenAI and any endpoint that implements the OpenAI chat
 * completions streaming protocol (DeepSeek, Moonshot, GLM, OpenRouter...).
 */
export class OpenAICompatibleProvider implements Provider {
  private readonly client: OpenAI;
  private readonly endpoint: string;
  private usageSupported = true;

  constructor(options: OpenAICompatibleOptions) {
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      defaultHeaders: options.headers,
      maxRetries: 0,
    });
    this.endpoint = createHash("sha256")
      .update(options.baseURL ?? "https://api.openai.com/v1")
      .digest("hex");
  }

  private create(request: ChatRequest, includeUsage: boolean) {
    return this.client.chat.completions.create(
      {
        model: request.model,
        messages: toOpenAIMessages(request.messages, {
          protocol: "openai-chat",
          endpoint: this.endpoint,
          model: request.model,
        }),
        tools:
          request.tools.length > 0
            ? request.tools.map((tool) => ({
                type: "function" as const,
                function: {
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.parameters,
                },
              }))
            : undefined,
        stream: true,
        ...(includeUsage ? { stream_options: { include_usage: true } } : {}),
      },
      { signal: request.signal },
    );
  }

  async *stream(request: ChatRequest): AsyncIterable<ProviderEvent> {
    let stream;
    try {
      stream = await this.create(request, this.usageSupported);
    } catch (error) {
      // Usage reporting is a nicety (it calibrates estimates); never let an
      // endpoint that does not understand stream_options break the agent.
      if (!this.usageSupported || !rejectsStreamOptions(error)) throw error;
      this.usageSupported = false;
      stream = await this.create(request, false);
    }

    const pending = new Map<number, ToolCall>();
    const reasoningDetails: unknown[] = [];
    let content = "";
    let reasoningContent = "";
    let reasoningField: "reasoning_content" | "reasoning" | undefined;
    let finishReason: string | null = null;
    let usage: TokenUsage | undefined;

    for await (const chunk of stream) {
      if (chunk.usage) {
        usage = {
          inputTokens: chunk.usage.prompt_tokens,
          outputTokens: chunk.usage.completion_tokens,
          reasoningTokens:
            chunk.usage.completion_tokens_details?.reasoning_tokens ??
            undefined,
        };
      }

      const choice = chunk.choices[0];
      if (!choice) continue;

      const delta = choice.delta;
      // Non-standard fields: DeepSeek/Kimi/Qwen use `reasoning_content`,
      // OpenRouter normalizes to `reasoning` plus `reasoning_details`. None of
      // these are in the OpenAI SDK types.
      const reasoningDelta = delta as
        | {
            reasoning_content?: string;
            reasoning?: string;
            reasoning_details?: unknown;
          }
        | undefined;

      if (
        typeof reasoningDelta?.reasoning_content === "string" &&
        reasoningDelta.reasoning_content.length > 0
      ) {
        reasoningField = "reasoning_content";
        reasoningContent += reasoningDelta.reasoning_content;
        yield { type: "reasoning", delta: reasoningDelta.reasoning_content };
      } else if (
        typeof reasoningDelta?.reasoning === "string" &&
        reasoningDelta.reasoning.length > 0
      ) {
        reasoningField = "reasoning";
        reasoningContent += reasoningDelta.reasoning;
        yield { type: "reasoning", delta: reasoningDelta.reasoning };
      }
      if (reasoningDelta?.reasoning_details !== undefined) {
        mergeReasoningDetails(reasoningDetails, reasoningDelta.reasoning_details);
      }

      if (typeof delta?.content === "string" && delta.content.length > 0) {
        content += delta.content;
        yield { type: "text", delta: delta.content };
      }

      for (const toolDelta of delta?.tool_calls ?? []) {
        const index = toolDelta.index ?? 0;
        const current = pending.get(index) ?? { id: "", name: "", arguments: "" };
        if (toolDelta.id) current.id = current.id || toolDelta.id;
        if (toolDelta.function?.name) current.name += toolDelta.function.name;
        if (toolDelta.function?.arguments) {
          current.arguments += toolDelta.function.arguments;
        }
        pending.set(index, current);
      }

      if (choice.finish_reason) finishReason = choice.finish_reason;
    }

    if (finishReason === null) {
      throw new Error("OpenAI Chat stream ended without a finish_reason.");
    }
    const toolCalls = [...pending.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, call]) => call);
    if ((finishReason === "tool_calls") !== (toolCalls.length > 0)) {
      throw new Error(`OpenAI Chat returned inconsistent tool calls (finish_reason: ${finishReason}).`);
    }
    if (
      toolCalls.some((call) => !call.id.trim() || !call.name.trim() || !call.arguments.trim()) ||
      new Set(toolCalls.map((call) => call.id)).size !== toolCalls.length
    ) {
      throw new Error("OpenAI Chat returned an incomplete or duplicate tool call.");
    }

    const payload: OpenAIReasoningPayload = {
      ...(reasoningField !== undefined ? { field: reasoningField } : {}),
      ...(reasoningContent.length > 0 ? { reasoningContent } : {}),
      ...(reasoningDetails.length > 0 ? { reasoningDetails } : {}),
    };
    const continuation: Continuation | undefined =
      reasoningContent.length > 0 || reasoningDetails.length > 0
        ? {
            protocol: "openai-chat",
            endpoint: this.endpoint,
            model: request.model,
            scope: "message",
            messageAnchor: hashAssistantFields(content, toolCalls),
            payload,
          }
        : undefined;

    yield {
      type: "done",
      message: {
        content,
        toolCalls,
        ...(continuation !== undefined ? { continuation } : {}),
      },
      finishReason,
      usage,
    };
  }
}
