import OpenAI from "openai";
import type {
  FunctionTool,
  ResponseFunctionToolCall,
  ResponseInputItem,
  ResponseOutputMessage,
  ResponseReasoningItem,
} from "openai/resources/responses/responses";
import { z } from "zod";
import type { Message, ToolCall } from "../types.js";
import {
  extendHistoryHash,
  hashAssistantFields,
  hashString,
  historySeed,
  matchesOwner,
  type Continuation,
  type ContinuationOwner,
} from "./continuation.js";
import type { ChatRequest, Provider, ProviderEvent } from "./types.js";

export type OpenAIResponsesOptions = {
  apiKey: string;
  /** Base URL without the /responses suffix. */
  baseURL?: string;
  headers?: Record<string, string>;
  maxOutputTokens?: number;
  requestReasoningSummary?: boolean;
};

type ReplayItem = ResponseOutputMessage | ResponseFunctionToolCall | ResponseReasoningItem;

// Validate persisted items without transforming or stripping provider fields.
const reasoningParts = (type: "summary_text" | "reasoning_text") =>
  z.array(z.object({ type: z.literal(type), text: z.string() }));
const outputItemsSchema = z.array(z.discriminatedUnion("type", [
  z.object({
    type: z.literal("message"),
    id: z.string(),
    role: z.literal("assistant"),
    content: z.array(z.discriminatedUnion("type", [
      z.object({ type: z.literal("output_text"), text: z.string() }),
      z.object({ type: z.literal("refusal"), refusal: z.string() }),
    ])),
  }),
  z.object({
    type: z.literal("function_call"),
    call_id: z.string().min(1),
    name: z.string().min(1),
    arguments: z.string(),
    status: z.literal("completed").optional(),
  }),
  z.object({
    type: z.literal("reasoning"),
    id: z.string(),
    summary: reasoningParts("summary_text").nullish(),
    content: reasoningParts("reasoning_text").nullish(),
    encrypted_content: z.string().nullish(),
  }),
]));

function isOutputItems(value: unknown): value is ReplayItem[] {
  return outputItemsSchema.safeParse(value).success;
}

function readAssistant(items: ReplayItem[]): { content: string; toolCalls: ToolCall[] } {
  let content = "";
  const toolCalls: ToolCall[] = [];
  for (const item of items) {
    if (item.type === "message") {
      for (const part of item.content) {
        content += part.type === "output_text" ? part.text : part.refusal;
      }
    } else if (item.type === "function_call") {
      toolCalls.push({ id: item.call_id, name: item.name, arguments: item.arguments });
    }
  }
  return { content, toolCalls };
}

function toInputItems(
  message: Message,
  owner: ContinuationOwner,
  prefix: string,
): ResponseInputItem[] {
  switch (message.role) {
    case "system":
    case "user":
      return [{ type: "message", role: message.role, content: message.content }];
    case "tool":
      return [{ type: "function_call_output", call_id: message.toolCallId, output: message.content }];
    case "assistant": {
      const state = message.continuation;
      if (state && state.scope === "response" && matchesOwner(state, owner) &&
          state.messageAnchor === hashAssistantFields(message.content, message.toolCalls) &&
          isOutputItems(state.payload)) {
        const original = readAssistant(state.payload);
        if (state.messageAnchor === hashAssistantFields(original.content, original.toolCalls)) {
          return state.stale || state.historyAnchor !== prefix
            ? state.payload.filter((item) => item.type !== "reasoning")
            : state.payload;
        }
      }

      const items: ResponseInputItem[] = [];
      if (message.content) {
        items.push({ type: "message", role: "assistant", content: message.content });
      }
      for (const call of message.toolCalls ?? []) {
        items.push({ type: "function_call", call_id: call.id, name: call.name, arguments: call.arguments });
      }
      return items;
    }
  }
}

function rejectsReasoningSummary(error: unknown): boolean {
  if (!(error instanceof OpenAI.APIError)) return false;
  if (error.status !== 400 && error.status !== 403 && error.status !== 422) return false;
  return error.param === "reasoning.summary" || error.param === "reasoning" ||
    /reasoning[ _-]summar|reasoning\.summary/i.test(error.message);
}

/** Client for the Responses API's stateless text and function-tool workflow. */
export class OpenAIResponsesProvider implements Provider {
  private readonly client: OpenAI;
  private readonly endpoint: string;

  constructor(private readonly options: OpenAIResponsesOptions) {
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      defaultHeaders: options.headers,
      maxRetries: 0,
    });
    this.endpoint = hashString(this.client.baseURL.replace(/\/+$/, ""));
  }

  async *stream(request: ChatRequest): AsyncIterable<ProviderEvent> {
    const owner: ContinuationOwner = {
      protocol: "openai-responses", endpoint: this.endpoint, model: request.model,
    };
    const tools = request.tools.map((tool): FunctionTool => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      // Cooper validates its own tool inputs and supports optional properties.
      strict: false,
    }));
    const input: ResponseInputItem[] = [];
    let prefix = historySeed(undefined, tools);
    for (const message of request.messages) {
      for (const item of toInputItems(message, owner, prefix)) {
        input.push(item);
        prefix = extendHistoryHash(prefix, item);
      }
    }

    const create = (summary: boolean) => this.client.responses.create({
      model: request.model,
      input,
      tools: tools.length > 0 ? tools : undefined,
      max_output_tokens: this.options.maxOutputTokens,
      stream: true,
      store: false,
      include: ["reasoning.encrypted_content"],
      reasoning: summary ? { summary: "auto" } : undefined,
    }, { signal: request.signal });

    let stream;
    try {
      stream = await create(this.options.requestReasoningSummary === true);
    } catch (error) {
      if (!this.options.requestReasoningSummary || !rejectsReasoningSummary(error)) throw error;
      stream = await create(false);
    }

    let streamedText = "";
    const finalizedReasoning = new Map<string, ResponseReasoningItem>();
    for await (const event of stream) {
      switch (event.type) {
        case "response.output_text.delta":
        case "response.refusal.delta":
          streamedText += event.delta;
          yield { type: "text", delta: event.delta };
          break;
        case "response.reasoning_summary_text.delta":
        case "response.reasoning_text.delta":
          yield { type: "reasoning", delta: event.delta };
          break;
        case "response.output_item.done":
          if (event.item.type === "reasoning" && isOutputItems([event.item])) {
            finalizedReasoning.set(event.item.id, event.item);
          }
          break;
        case "response.failed":
          throw new Error(event.response.error?.message ?? "OpenAI Responses request failed.");
        case "response.incomplete":
          throw new Error(`OpenAI Responses returned an incomplete response (${event.response.incomplete_details?.reason ?? "unknown reason"}).`);
        case "error":
          throw new Error(event.message);
        case "response.completed": {
          // Wait for the terminal response before handing any tool call to the agent.
          const { output, status, usage } = event.response;
          if ((status !== undefined && status !== "completed") || !isOutputItems(output)) {
            throw new Error("OpenAI Responses returned an invalid completion or unsupported output item.");
          }
          const items = output.map((item) => {
            if (item.type !== "reasoning") return item;
            const finalized = finalizedReasoning.get(item.id);
            if (finalized && (finalized.encrypted_content || !item.encrypted_content)) return finalized;
            return item;
          });
          const { content, toolCalls } = readAssistant(items);
          if (new Set(toolCalls.map((call) => call.id)).size !== toolCalls.length) {
            throw new Error("OpenAI Responses returned duplicate function call IDs.");
          }
          if (content.length > streamedText.length && content.startsWith(streamedText)) {
            yield { type: "text", delta: content.slice(streamedText.length) };
          }
          const continuation: Continuation = {
            ...owner,
            scope: "response",
            messageAnchor: hashAssistantFields(content, toolCalls),
            historyAnchor: prefix,
            payload: items,
          };
          yield {
            type: "done",
            message: { content, toolCalls, continuation },
            finishReason: toolCalls.length > 0 ? "tool_calls" : "stop",
            usage: usage ? {
              inputTokens: usage.input_tokens,
              outputTokens: usage.output_tokens,
              reasoningTokens: usage.output_tokens_details?.reasoning_tokens,
            } : undefined,
          };
          return;
        }
      }
    }
    request.signal?.throwIfAborted();
    throw new Error("OpenAI Responses stream ended before a terminal event.");
  }
}
