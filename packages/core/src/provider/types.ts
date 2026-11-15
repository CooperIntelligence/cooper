import type { Message, ProviderData, ToolCall, ToolSpec } from "../types.js";
import type { Continuation } from "./continuation.js";
import type { ReasoningEffort } from "../model-selection.js";

export type ModelRequestOptions = {
  model: string;
  reasoningEffort?: ReasoningEffort;
  maxOutputTokens?: number;
};

export type AssistantMessage = {
  content: string;
  toolCalls: ToolCall[];
  /** Protocol state that must be replayed to the same provider. */
  continuation?: Continuation;
  /** Legacy continuation data read from older sessions. */
  providerData?: ProviderData;
};

export type ChatRequest = {
  model: string;
  messages: Message[];
  tools: ToolSpec[];
  signal?: AbortSignal;
  /** Explicitly configured summary requests use the service's base options. */
  purpose?: "summary";
};

export function modelOptionsForRequest(request: ChatRequest, options?: ModelRequestOptions): ModelRequestOptions | undefined {
  return request.purpose !== "summary" && options?.model === request.model ? options : undefined;
}

export type TokenUsage = {
  inputTokens?: number;
  outputTokens?: number;
  /** Output tokens spent on reasoning, when the provider breaks them out. */
  reasoningTokens?: number;
};

export type ProviderEvent =
  | { type: "text"; delta: string }
  /** Display-only reasoning text. The adapter handles protocol continuation data. */
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
  /** Number of leading history messages to keep verbatim during a tool round. */
  protectedToolHistoryLength?(request: ChatRequest): number;
  /** Estimates serialized input, including only continuation eligible for replay. */
  estimateInputTokens?(request: ChatRequest): number;
}
