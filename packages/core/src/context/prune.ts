import type { Message } from "../types.js";
import { estimateTextTokens } from "./estimator.js";
import { toolCallIndex } from "./groups.js";

export type PruneOptions = {
  /** Most recent tool results that stay verbatim. */
  keepRecent?: number;
  /** Results shorter than this are not worth stubbing. */
  minChars?: number;
  /** Preserve the history before this index. */
  startIndex?: number;
};

export type PruneStats = {
  pruned: number;
  reclaimedTokens: number;
};

function describeCall(name: string, args: string): string {
  const flat = args.replace(/\s+/g, " ").trim();
  return `${name}(${flat.length > 100 ? `${flat.slice(0, 99)}…` : flat})`;
}

/**
 * Replaces the content of old tool results with a stub. The message itself
 * stays: the chat protocol requires a `tool` message for every tool_call, and
 * the assistant message already records what was asked, so only the output is
 * lost — and the model can re-run the tool when it needs it again.
 *
 * Mutates `messages` in place; callers hold this array as session history.
 */
export function pruneToolOutputs(
  messages: Message[],
  options: PruneOptions = {},
): PruneStats {
  const keepRecent = options.keepRecent ?? 8;
  const minChars = options.minChars ?? 1000;
  const calls = toolCallIndex(messages);

  const toolIndices: number[] = [];
  for (let index = options.startIndex ?? 0; index < messages.length; index += 1) {
    if (messages[index]?.role === "tool") toolIndices.push(index);
  }

  const cutoff = Math.max(0, toolIndices.length - keepRecent);
  let pruned = 0;
  let reclaimedTokens = 0;

  for (let position = 0; position < cutoff; position += 1) {
    const index = toolIndices[position];
    if (index === undefined) continue;
    const message = messages[index];
    if (message === undefined || message.role !== "tool") continue;
    if (message.content.length <= minChars) continue;

    const call = calls.get(message.toolCallId);
    const label = call
      ? describeCall(call.name, call.arguments)
      : message.toolCallId;

    const before = estimateTextTokens(message.content);
    const stub =
      `[Tool result elided to save context: ${label} returned ` +
      `${message.content.length} chars (~${before} tokens). ` +
      `Re-run the tool if you need the details.]`;
    const reclaimed = before - estimateTextTokens(stub);
    if (reclaimed <= 0) continue;
    messages[index] = { ...message, content: stub };

    pruned += 1;
    reclaimedTokens += reclaimed;
  }

  return { pruned, reclaimedTokens };
}
