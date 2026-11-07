import type { Message, ToolCall, ToolSpec } from "../types.js";

export type AssistantMessage = {
  content: string;
  toolCalls: ToolCall[];
};

export type ChatRequest = {
  model: string;
  messages: Message[];
  tools: ToolSpec[];
  signal?: AbortSignal;
};

export type ProviderEvent =
  | { type: "text"; delta: string }
  | { type: "done"; message: AssistantMessage; finishReason: string | null };

/**
 * Minimal streaming chat interface. Every provider (OpenAI-compatible,
 * Anthropic, later local models) normalizes into these events so the agent
 * loop never depends on a vendor SDK.
 */
export interface Provider {
  stream(request: ChatRequest): AsyncIterable<ProviderEvent>;
}
