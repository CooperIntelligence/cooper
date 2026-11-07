import OpenAI from "openai";
import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import type { Message, ToolCall } from "../types.js";
import type { ChatRequest, Provider, ProviderEvent } from "./types.js";

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

/**
 * Works with OpenAI and any endpoint that implements the OpenAI chat
 * completions streaming protocol (DeepSeek, Moonshot, GLM, OpenRouter...).
 */
export class OpenAICompatibleProvider implements Provider {
  private readonly client: OpenAI;

  constructor(options: OpenAICompatibleOptions) {
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      defaultHeaders: options.headers,
      maxRetries: 0,
    });
  }

  async *stream(request: ChatRequest): AsyncIterable<ProviderEvent> {
    const stream = await this.client.chat.completions.create(
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
      },
      { signal: request.signal },
    );

    const pending = new Map<number, ToolCall>();
    let content = "";
    let finishReason: string | null = null;

    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      if (!choice) continue;

      const delta = choice.delta;
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

    yield { type: "done", message: { content, toolCalls }, finishReason };
  }
}
