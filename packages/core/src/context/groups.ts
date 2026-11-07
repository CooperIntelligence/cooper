import type { Message, ToolCall } from "../types.js";

/**
 * An atomic slice of the transcript. The chat protocol requires every tool
 * result to follow the assistant message that requested it, so an assistant
 * message and its results must be moved, kept, or dropped together.
 */
export type MessageGroup = {
  /** Index of the first message in the full array (inclusive). */
  start: number;
  /** Index just past the last message (exclusive). */
  end: number;
  messages: Message[];
};

export function groupMessages(messages: Message[]): MessageGroup[] {
  const groups: MessageGroup[] = [];
  let index = 0;

  while (index < messages.length) {
    const message = messages[index];
    if (message === undefined) break;

    if (
      message.role === "assistant" &&
      message.toolCalls !== undefined &&
      message.toolCalls.length > 0
    ) {
      const expected = new Set(message.toolCalls.map((call) => call.id));
      let end = index + 1;
      while (end < messages.length) {
        const next = messages[end];
        if (
          next === undefined ||
          next.role !== "tool" ||
          !expected.has(next.toolCallId)
        ) {
          break;
        }
        expected.delete(next.toolCallId);
        end += 1;
      }
      groups.push({ start: index, end, messages: messages.slice(index, end) });
      index = end;
    } else {
      groups.push({ start: index, end: index + 1, messages: [message] });
      index += 1;
    }
  }

  return groups;
}

/** Maps tool_call ids to the call that produced them, for labelling results. */
export function toolCallIndex(messages: Message[]): Map<string, ToolCall> {
  const calls = new Map<string, ToolCall>();
  for (const message of messages) {
    if (message.role === "assistant" && message.toolCalls) {
      for (const call of message.toolCalls) calls.set(call.id, call);
    }
  }
  return calls;
}

/** Leading system messages are never compacted. */
export function leadingSystemCount(messages: Message[]): number {
  let count = 0;
  while (count < messages.length) {
    const message = messages[count];
    if (message === undefined || message.role !== "system") break;
    count += 1;
  }
  return count;
}

/**
 * Finds the earliest index that can be compacted away while keeping at least
 * `keepTokens` of recent history intact, always leaving the newest group in
 * place and never cutting into the leading system block.
 *
 * Returns a group boundary: everything before it is safe to summarize or drop.
 */
export function findCompactionCut(
  messages: Message[],
  keepTokens: number,
  tokensOf: (message: Message) => number,
): number {
  const systemEnd = leadingSystemCount(messages);
  const groups = groupMessages(messages);
  let kept = 0;
  let cut = messages.length;

  for (let i = groups.length - 1; i >= 0; i -= 1) {
    const group = groups[i];
    if (group === undefined || group.start < systemEnd) break;

    const tokens = group.messages.reduce((sum, m) => sum + tokensOf(m), 0);
    // Always keep the newest group, even if it alone exceeds the budget.
    if (kept + tokens > keepTokens && cut < messages.length) break;

    kept += tokens;
    cut = group.start;
  }

  return Math.max(cut, systemEnd);
}
