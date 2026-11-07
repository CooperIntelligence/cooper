import type { Message, ToolCall } from "../types.js";
import type { Provider } from "../provider/types.js";
import { estimateMessageTokens } from "./estimator.js";
import { groupMessages, toolCallIndex } from "./groups.js";

export type SummarizeOptions = {
  provider: Provider;
  model: string;
  /** The prefix being replaced by the summary. */
  messages: Message[];
  /** Desired size of the resulting summary. */
  budgetTokens?: number;
  /** Upper bound for a single summarizer request. */
  chunkTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
};

const SUMMARY_SYSTEM = [
  "You compress the transcript of a coding-agent session into dense notes.",
  "Preserve, as short bullets:",
  "- the user's original goal and any explicit constraints",
  "- decisions made and why, including rejected alternatives",
  "- files created, modified, or deleted (full paths) and what changed",
  "- commands run and whether they succeeded",
  "- errors hit and how they were resolved, or that they are still open",
  "- what is still pending",
  "Drop full file contents, long command output, and repeated reasoning.",
  "Write in English. Reply with the notes only, no preamble.",
].join("\n");

const MAX_MESSAGE_CHARS = 1200;
const MAX_TOOL_ARG_CHARS = 300;

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function renderMessage(message: Message, calls: Map<string, ToolCall>): string {
  switch (message.role) {
    case "system":
      return `SYSTEM: ${truncate(message.content, 600)}`;
    case "user":
      return `USER: ${truncate(message.content, MAX_MESSAGE_CHARS)}`;
    case "assistant": {
      const parts: string[] = [];
      if (message.content.trim().length > 0) {
        parts.push(truncate(message.content, MAX_MESSAGE_CHARS));
      }
      for (const call of message.toolCalls ?? []) {
        parts.push(
          `[called ${call.name} with ${truncate(call.arguments, MAX_TOOL_ARG_CHARS)}]`,
        );
      }
      return `ASSISTANT: ${parts.join(" ")}`;
    }
    case "tool": {
      const name = calls.get(message.toolCallId)?.name;
      const label = name ? `TOOL RESULT (${name})` : "TOOL RESULT";
      return `${label}: ${truncate(message.content, MAX_MESSAGE_CHARS)}`;
    }
  }
}

/** Splits on group boundaries so a tool call is never separated from its result. */
export function chunkMessages(
  messages: Message[],
  maxTokens: number,
): Message[][] {
  const chunks: Message[][] = [];
  let current: Message[] = [];
  let tokens = 0;

  for (const group of groupMessages(messages)) {
    const groupTokens = group.messages.reduce(
      (sum, message) => sum + estimateMessageTokens(message),
      0,
    );
    if (current.length > 0 && tokens + groupTokens > maxTokens) {
      chunks.push(current);
      current = [];
      tokens = 0;
    }
    current.push(...group.messages);
    tokens += groupTokens;
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}

function withTimeout(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function summarizeChunk(
  messages: Message[],
  options: SummarizeOptions,
): Promise<string> {
  const budgetTokens = options.budgetTokens ?? 1200;
  const calls = toolCallIndex(messages);
  const transcript = messages
    .map((message) => renderMessage(message, calls))
    .join("\n\n");

  let text = "";
  for await (const event of options.provider.stream({
    model: options.model,
    messages: [
      { role: "system", content: SUMMARY_SYSTEM },
      {
        role: "user",
        content:
          `Summarize this transcript in at most ${budgetTokens} tokens.\n\n` +
          `<transcript>\n${transcript}\n</transcript>`,
      },
    ],
    tools: [],
    signal: withTimeout(options.signal, options.timeoutMs ?? 60_000),
  })) {
    if (event.type === "text") {
      text += event.delta;
    } else if (event.type === "done" && event.message.content) {
      text = event.message.content;
    }
  }

  const trimmed = text.trim();
  if (trimmed.length === 0) throw new Error("Summarizer returned no text.");
  return trimmed;
}

/**
 * Summarizes a transcript prefix. Long prefixes are summarized in chunks and
 * folded together, so the summarizer request itself never has to fit the
 * whole prefix in one context window.
 */
export async function summarizeMessages(
  options: SummarizeOptions,
): Promise<string> {
  const chunkTokens = options.chunkTokens ?? 60_000;
  const chunks = chunkMessages(options.messages, chunkTokens);
  if (chunks.length === 0) throw new Error("Nothing to summarize.");

  const partials: string[] = [];
  for (const chunk of chunks) {
    partials.push(await summarizeChunk(chunk, options));
  }

  if (partials.length === 1) return partials[0] ?? "";

  return summarizeChunk(
    [
      {
        role: "user",
        content: partials
          .map((partial, index) => `PART ${index + 1}:\n${partial}`)
          .join("\n\n"),
      },
    ],
    options,
  );
}
