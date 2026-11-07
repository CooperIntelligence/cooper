import type { Message, ToolSpec } from "../types.js";

/**
 * Token estimation without a vendor tokenizer.
 *
 * The split that matters is CJK vs everything else: Chinese/Japanese/Korean
 * text costs roughly one token per character, while Latin text and code cost
 * roughly one token per 3.6 characters. A single chars/4 ratio underestimates
 * Chinese prompts by three to four times, which is exactly the failure this
 * budget exists to prevent.
 */
const CJK_TOKENS_PER_CHAR = 1.1;
const LATIN_CHARS_PER_TOKEN = 3.6;
const MESSAGE_OVERHEAD = 4;
const TOOL_CALL_OVERHEAD = 8;

function isCjk(codePoint: number): boolean {
  return (
    (codePoint >= 0x3000 && codePoint <= 0x303f) || // CJK symbols, punctuation
    (codePoint >= 0x3040 && codePoint <= 0x30ff) || // hiragana, katakana
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) || // CJK extension A
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) || // CJK unified ideographs
    (codePoint >= 0xac00 && codePoint <= 0xd7af) || // hangul
    (codePoint >= 0xf900 && codePoint <= 0xfaff) || // compatibility ideographs
    (codePoint >= 0xff00 && codePoint <= 0xffef) // halfwidth/fullwidth forms
  );
}

export function estimateTextTokens(text: string): number {
  let cjk = 0;
  let total = 0;
  for (const char of text) {
    total += 1;
    const codePoint = char.codePointAt(0);
    if (codePoint !== undefined && isCjk(codePoint)) cjk += 1;
  }
  const latin = total - cjk;
  return Math.ceil(cjk * CJK_TOKENS_PER_CHAR + latin / LATIN_CHARS_PER_TOKEN);
}

export function estimateMessageTokens(message: Message): number {
  let tokens = MESSAGE_OVERHEAD + estimateTextTokens(message.content);
  if (message.role === "assistant" && message.toolCalls) {
    for (const call of message.toolCalls) {
      tokens +=
        TOOL_CALL_OVERHEAD +
        estimateTextTokens(call.name) +
        estimateTextTokens(call.arguments);
    }
  }
  return tokens;
}

/** Tool schemas are resent on every request, so they count against the budget. */
export function estimateToolSpecTokens(tools: ToolSpec[]): number {
  if (tools.length === 0) return 0;
  return estimateTextTokens(JSON.stringify(tools));
}

export function estimateConversationTokens(
  messages: Message[],
  tools: ToolSpec[] = [],
): number {
  let total = estimateToolSpecTokens(tools);
  for (const message of messages) {
    total += estimateMessageTokens(message);
  }
  return total;
}

/**
 * Multiplier learned from real `usage` numbers reported by the provider.
 * Starts at 1 (trust the heuristic) and blends toward the observed ratio.
 */
export type Calibration = { ratio: number; samples: number };

export const INITIAL_CALIBRATION: Calibration = { ratio: 1, samples: 0 };

export function updateCalibration(
  previous: Calibration,
  actualTokens: number,
  estimatedTokens: number,
): Calibration {
  if (actualTokens <= 0 || estimatedTokens <= 0) return previous;
  // Clamp so one malformed response cannot wreck the estimate.
  const observed = Math.min(1.5, Math.max(0.5, actualTokens / estimatedTokens));
  const ratio =
    previous.samples === 0
      ? observed
      : previous.ratio * 0.7 + observed * 0.3;
  return { ratio, samples: Math.min(previous.samples + 1, 50) };
}

export function applyCalibration(tokens: number, calibration: Calibration): number {
  return Math.ceil(tokens * calibration.ratio);
}
