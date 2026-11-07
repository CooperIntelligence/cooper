import type { Message, ToolSpec } from "../types.js";
import type { Provider } from "../provider/types.js";
import {
  INITIAL_CALIBRATION,
  applyCalibration,
  estimateConversationTokens,
  estimateMessageTokens,
  type Calibration,
} from "./estimator.js";
import {
  findCompactionCut,
  groupMessages,
  leadingSystemCount,
} from "./groups.js";
import { pruneToolOutputs } from "./prune.js";
import { summarizeMessages } from "./summarize.js";
import { DEFAULT_CONTEXT_WINDOW } from "./window.js";

export type ContextSettings = {
  window: number;
  /** Tokens kept free for the model's reply. */
  reserveOutputTokens?: number;
  /** Fraction of the usable budget that triggers tool-output pruning. */
  pruneAt?: number;
  /** Fraction that triggers summarization. */
  summarizeAt?: number;
  /** Fraction to compact down to after summarizing (hysteresis). */
  targetAfterSummary?: number;
  /** Fraction that triggers forced truncation. */
  hardLimit?: number;
  keepRecentToolResults?: number;
  /** Cheaper model for summaries; defaults to the main model. */
  summaryModel?: string;
  enabled?: boolean;
};

export type ContextConfig = {
  window: number;
  reserveOutputTokens: number;
  pruneAt: number;
  summarizeAt: number;
  targetAfterSummary: number;
  hardLimit: number;
  keepRecentToolResults: number;
  summaryModel: string | undefined;
  enabled: boolean;
};

export function resolveContextConfig(settings: ContextSettings): ContextConfig {
  return {
    window: settings.window,
    // Leave room for a reply that includes a whole file write, not just chat.
    reserveOutputTokens: settings.reserveOutputTokens ?? 16_384,
    pruneAt: settings.pruneAt ?? 0.65,
    summarizeAt: settings.summarizeAt ?? 0.8,
    targetAfterSummary: settings.targetAfterSummary ?? 0.45,
    hardLimit: settings.hardLimit ?? 0.92,
    keepRecentToolResults: settings.keepRecentToolResults ?? 8,
    summaryModel: settings.summaryModel,
    enabled: settings.enabled ?? true,
  };
}

export const DEFAULT_CONTEXT_CONFIG: ContextConfig = resolveContextConfig({
  window: DEFAULT_CONTEXT_WINDOW,
});

export type ContextAction = {
  action: "prune" | "summarize" | "truncate";
  /** Estimated tokens before and after this step. */
  before: number;
  after: number;
};

export type PrepareContextOptions = {
  messages: Message[];
  tools: ToolSpec[];
  provider: Provider;
  model: string;
  config: ContextConfig;
  calibration?: Calibration;
  signal?: AbortSignal;
  /** Ignore the thresholds and compact as much as possible. */
  force?: boolean;
  /**
   * Overrides `window - reserveOutputTokens`. Used after the API rejects a
   * request: the real window is smaller than the one we assumed, so compact
   * to a fraction of what we just tried.
   */
  budgetOverride?: number;
};

export function estimateContextTokens(
  messages: Message[],
  tools: ToolSpec[] = [],
  calibration: Calibration = INITIAL_CALIBRATION,
): number {
  return applyCalibration(
    estimateConversationTokens(messages, tools),
    calibration,
  );
}

const SUMMARY_BUDGET_TOKENS = 1200;

/**
 * Keeps `messages` inside the model's window, cheapest mechanism first:
 *
 *   1. prune old tool output (local, free)
 *   2. summarize the older half (one model call)
 *   3. drop whole groups (local, always succeeds)
 *
 * Mutates the array in place so the caller's session history stays in sync
 * with what will actually be sent.
 */
export async function prepareContext(
  options: PrepareContextOptions,
): Promise<ContextAction[]> {
  const { messages, tools, config, force = false } = options;
  if (!config.enabled) return [];

  const calibration = options.calibration ?? INITIAL_CALIBRATION;
  // Never reserve more than a quarter of the window: with a small local model
  // the 16k default would otherwise eat half the usable budget.
  const reserve = Math.min(
    config.reserveOutputTokens,
    Math.floor(config.window * 0.25),
  );
  const usable = Math.max(
    2048,
    options.budgetOverride ?? config.window - reserve,
  );
  const estimate = () => estimateContextTokens(messages, tools, calibration);

  let current = estimate();
  const pruneLimit = usable * config.pruneAt;
  const summarizeLimit = usable * config.summarizeAt;
  const hardLimit = usable * config.hardLimit;
  const target = usable * config.targetAfterSummary;

  const actions: ContextAction[] = [];

  // 1. Prune tool output, escalating to a smaller tail if one pass is not enough.
  if (force || current > pruneLimit) {
    const before = current;
    for (const keepRecent of [config.keepRecentToolResults, 4, 2]) {
      if (current <= (force ? summarizeLimit : pruneLimit)) break;
      const stats = pruneToolOutputs(messages, { keepRecent });
      if (stats.pruned === 0) break;
      current = estimate();
    }
    if (current < before) {
      actions.push({ action: "prune", before, after: current });
    }
  }

  // 2. Summarize the prefix, keeping the recent tail verbatim.
  if (force || current > summarizeLimit) {
    const before = current;
    const systemEnd = leadingSystemCount(messages);
    const keepTokens = Math.max(
      1024,
      Math.floor(target) - SUMMARY_BUDGET_TOKENS,
    );
    const cut = findCompactionCut(
      messages,
      keepTokens,
      (message) => Math.ceil(estimateMessageTokens(message) * calibration.ratio),
    );

    const prefix = cut > systemEnd ? messages.slice(systemEnd, cut) : [];
    const prefixTokens = Math.ceil(
      prefix.reduce((sum, message) => sum + estimateMessageTokens(message), 0) *
        calibration.ratio,
    );

    // Summarizing a small prefix costs more than it saves (the replacement is
    // at least a few hundred tokens), so don't even make the call.
    if (cut > systemEnd && prefixTokens > SUMMARY_BUDGET_TOKENS * 2) {
      try {
        const summary = await summarizeMessages({
          provider: options.provider,
          model: config.summaryModel ?? options.model,
          messages: prefix,
          budgetTokens: SUMMARY_BUDGET_TOKENS,
          chunkTokens: Math.min(
            60_000,
            Math.max(8_000, Math.floor(usable * 0.5)),
          ),
          signal: options.signal,
        });

        const replacement: Message = {
          role: "user",
          content: [
            "[Earlier conversation summary — the original messages were",
            "compacted to save context. Ask for details if you need them.]",
            "",
            summary,
          ].join("\n"),
        };
        messages.splice(systemEnd, cut - systemEnd, replacement);
        const after = estimate();
        if (after < before) {
          current = after;
          actions.push({ action: "summarize", before, after });
        } else {
          // The summary did not pay for itself; restore and let truncation
          // handle it rather than shipping a larger transcript.
          messages.splice(systemEnd, 1, ...prefix);
          current = before;
        }
      } catch {
        // Never block the request on a failed summary; truncation is next.
      }
    }
  }

  // 3. Drop whole groups until under target. Always leaves the newest group.
  if (force || current > hardLimit) {
    const before = current;
    const systemEnd = leadingSystemCount(messages);
    const original = messages.slice();
    let dropped = 0;

    while (current > target) {
      const groups = groupMessages(messages.slice(systemEnd));
      if (groups.length <= 1) break;
      const first = groups[0];
      if (first === undefined) break;
      const length = first.end - first.start;
      messages.splice(systemEnd, length);
      dropped += length;
      current = estimate();
    }

    if (dropped > 0) {
      messages.splice(systemEnd, 0, {
        role: "user",
        content:
          `[${dropped} earlier messages were dropped because the conversation ` +
          `exceeded the context window. Re-read files or re-run commands if ` +
          `you need their details.]`,
      });
      current = estimate();
    }

    if (dropped > 0 && current < before) {
      actions.push({ action: "truncate", before, after: current });
    } else if (dropped > 0) {
      // Dropping did not help (a single oversized message dominates the
      // budget). Put everything back instead of losing the user's request.
      messages.splice(0, messages.length, ...original);
      current = before;
    }
  }

  return actions;
}
