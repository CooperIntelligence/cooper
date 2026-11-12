import { createHash } from "node:crypto";
import type { Message, ToolCall } from "../types.js";

/**
 * Wire protocols Cooper can speak. Continuation payloads are namespaced by
 * protocol so one adapter can never replay another adapter's data.
 */
export type ContinuationProtocol =
  | "openai-chat"
  | "anthropic-messages"
  | "openai-responses"
  | "gemini";

/**
 * How long a continuation payload stays valid:
 *
 * - `message`: the payload belongs to one assistant message. Keep it while
 *   that message is unchanged; prefix edits elsewhere are irrelevant.
 * - `prefix`: the payload is bound to everything sent before the message
 *   (system prompt, tools, and prior messages). Any edit before it invalidates
 *   it. Anthropic thinking blocks work this way.
 * - `response`: the payload continues one provider response. Any history edit
 *   invalidates it. OpenAI Responses / Gemini work this way.
 */
export type ContinuationScope = "message" | "prefix" | "response";

/**
 * Opaque protocol state that must be replayed to the provider that produced
 * it. The core never interprets `payload`; only the owning adapter does.
 */
export type Continuation = {
  protocol: ContinuationProtocol;
  /** sha256 of the endpoint base URL. Never contains the API key. */
  endpoint: string;
  model: string;
  scope: ContinuationScope;
  /** Hash of the assistant message's visible fields (content + toolCalls). */
  messageAnchor: string;
  /** Required for `prefix` / `response`: hash of the request prefix. */
  historyAnchor?: string;
  /**
   * Set when compaction edited the history before this message. The payload is
   * kept because its visible blocks are still exact; adapters must drop only
   * the prefix-bound parts (e.g. thinking blocks) before replay.
   */
  stale?: boolean;
  /** Opaque, ordered wire payload. */
  payload: unknown;
};

export type ContinuationOwner = {
  protocol: ContinuationProtocol;
  endpoint: string;
  model: string;
};

const PROTOCOLS = new Set<ContinuationProtocol>([
  "openai-chat",
  "anthropic-messages",
  "openai-responses",
  "gemini",
]);

const SCOPES = new Set<ContinuationScope>(["message", "prefix", "response"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hashString(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Deterministic JSON: sorted keys, no `undefined`, no whitespace. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value)) ?? "null";
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const entry = value[key];
      if (entry !== undefined) out[key] = canonicalize(entry);
    }
    return out;
  }
  return value;
}

export function hashJson(value: unknown): string {
  return hashString(canonicalJson(value));
}

/** Visible fields of an assistant message. Never includes continuation data. */
export function hashAssistantFields(
  content: string,
  toolCalls: readonly ToolCall[] | undefined,
): string {
  return hashJson({ content, toolCalls: toolCalls ?? [] });
}

export function hashAssistantMessage(
  message: Pick<Message & { role: "assistant" }, "content" | "toolCalls">,
): string {
  return hashAssistantFields(message.content, message.toolCalls);
}

/**
 * Seed for the rolling request-prefix hash. The adapter must use the exact
 * system prompt and tool list it will send.
 */
export function historySeed(system: string | undefined, tools: unknown): string {
  return hashJson({ system: system ?? "", tools });
}

/** Extends a rolling hash with one wire message, exactly as sent. */
export function extendHistoryHash(hash: string, wireMessage: unknown): string {
  return hashString(hash + canonicalJson(wireMessage));
}

export function matchesOwner(
  continuation: Continuation,
  owner: ContinuationOwner,
): boolean {
  return (
    continuation.protocol === owner.protocol &&
    continuation.endpoint === owner.endpoint &&
    continuation.model === owner.model
  );
}

export function isContinuation(value: unknown): value is Continuation {
  if (!isRecord(value)) return false;
  return (
    typeof value.protocol === "string" &&
    PROTOCOLS.has(value.protocol as ContinuationProtocol) &&
    typeof value.endpoint === "string" &&
    typeof value.model === "string" &&
    typeof value.scope === "string" &&
    SCOPES.has(value.scope as ContinuationScope) &&
    typeof value.messageAnchor === "string" &&
    (value.historyAnchor === undefined ||
      typeof value.historyAnchor === "string") &&
    (value.stale === undefined || typeof value.stale === "boolean") &&
    "payload" in value
  );
}

/**
 * Marks every payload whose validity depends on the history that compaction
 * just edited. Message-scoped payloads travel with their own message and are
 * untouched.
 *
 * The payload itself is kept: its visible text/tool_use blocks are still exact,
 * and an adapter that drops only its thinking blocks can replay them without
 * rebuilding the message. Adapters still validate owners and anchors before
 * every request, so a missed call cannot ship stale thinking.
 */
export function invalidatePrefixContinuations(messages: Message[]): void {
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    if (message.continuation !== undefined && message.continuation.scope !== "message") {
      message.continuation.stale = true;
    }
    // Legacy Anthropic thinking blocks cannot be filtered by the core because
    // their shape is provider-owned; drop them.
    if (message.providerData !== undefined) delete message.providerData;
  }
}
