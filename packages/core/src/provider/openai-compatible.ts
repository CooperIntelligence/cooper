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

export type OpenAICompatibleOptions = {
  apiKey: string;
  /** Base URL without the /chat/completions suffix. */
  baseURL?: string;
  headers?: Record<string, string>;
};

function toOpenAIMessages(messages: Message[]): ChatCompletionMessageParam[] {
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
 * Works with OpenAI and any endpoint that implements the OpenAI chat
 * completions streaming protocol (DeepSeek, Moonshot, GLM, OpenRouter...).
 */
export class OpenAICompatibleProvider implements Provider {
  private readonly client: OpenAI;
  private usageSupported = true;

  constructor(options: OpenAICompatibleOptions) {
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      defaultHeaders: options.headers,
      maxRetries: 0,
    });
  }

  private create(request: ChatRequest, includeUsage: boolean) {
    return this.client.chat.completions.create(
      {
        model: request.model,
        messages: toOpenAIMessages(request.messages),
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
    let content = "";
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
      // OpenRouter normalizes to `reasoning`. Neither is in the SDK types.
      const reasoningDelta = delta as
        | { reasoning_content?: string; reasoning?: string }
        | undefined;
      const reasoning =
        reasoningDelta?.reasoning_content ?? reasoningDelta?.reasoning;
      if (typeof reasoning === "string" && reasoning.length > 0) {
        yield { type: "reasoning", delta: reasoning };
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

    const toolCalls = [...pending.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, call]) => ({
        id: call.id || `call_${index}`,
        name: call.name,
        arguments: call.arguments || "{}",
      }));

    yield { type: "done", message: { content, toolCalls }, finishReason, usage };
  }
}
