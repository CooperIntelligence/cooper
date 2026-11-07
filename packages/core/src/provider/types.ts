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

export type TokenUsage = {
  inputTokens?: number;
  outputTokens?: number;
  /** Output tokens spent on reasoning, when the provider breaks them out. */
  reasoningTokens?: number;
};

export type ProviderEvent =
  | { type: "text"; delta: string }
  /**
   * A reasoning/thinking summary. Never part of the conversation history:
   * providers such as DeepSeek reject `reasoning_content` being sent back,
   * and unfaithful reasoning must not become context for later turns.
   */
  | { type: "reasoning"; delta: string }
  | {
      type: "done";
      message: AssistantMessage;
      finishReason: string | null;
      /** Present when the endpoint reports usage; used to calibrate estimates. */
      usage?: TokenUsage;
    };

/**
 * Minimal streaming chat interface. Every provider (OpenAI-compatible,
 * Anthropic, later local models) normalizes into these events so the agent
 * loop never depends on a vendor SDK.
 */
export interface Provider {
  stream(request: ChatRequest): AsyncIterable<ProviderEvent>;
}
