/**
 * Context window sizes for known model families.
 *
 * Sources: vendor docs as of 2026. This table is a heuristic, not a promise —
 * the same model name can expose different windows behind different gateways.
 * Overestimating is survivable (the agent retries after the API rejects the
 * request); underestimating only compacts early. Unknown models get the same
 * 200k assumption Claude Code uses for unrecognized model IDs.
 */
export const DEFAULT_CONTEXT_WINDOW = 200_000;

const RULES: Array<{ model: RegExp; window: number }> = [
  // Anthropic — 1M on current flagships, 200k on older families.
  { model: /\[1m\]/i, window: 1_000_000 },
  { model: /^claude-(fable|mythos|opus|sonnet|haiku)-([5-9]|\d\d)/i, window: 1_000_000 },
  { model: /^claude-opus-4\.[7-9]/i, window: 1_000_000 },
  { model: /^claude-/i, window: 200_000 },

  // OpenAI — gpt-5.x is 1.05M on the API, but channels often expose 258k–400k
  // and prices jump above 272k, so 400k is the safer planning figure.
  { model: /^gpt-5/i, window: 400_000 },
  { model: /^gpt-4\.1/i, window: 1_000_000 },
  { model: /^gpt-4o/i, window: 128_000 },
  { model: /^gpt-4/i, window: 128_000 },
  { model: /^o[1-9]/i, window: 200_000 },

  { model: /^gemini-/i, window: 1_048_576 },
  { model: /^gemma-/i, window: 128_000 },

  // DeepSeek — V4 and later are 1M; chat/reasoner aliases historically 128k.
  { model: /^deepseek-.*v[4-9]/i, window: 1_000_000 },
  { model: /^deepseek-/i, window: 128_000 },

  { model: /^kimi-k3/i, window: 1_048_576 },
  { model: /^kimi-/i, window: 262_144 },
  { model: /^moonshot-/i, window: 262_144 },

  { model: /^qwen3\.[7-9]/i, window: 1_000_000 },
  { model: /^qwen/i, window: 262_144 },

  { model: /^glm/i, window: 128_000 },
  { model: /^grok/i, window: 256_000 },
  { model: /^llama/i, window: 128_000 },
  { model: /^mistral|^codestral/i, window: 128_000 },
];

export type ContextWindow = {
  window: number;
  /** True when the model was not recognised and the default was assumed. */
  assumed: boolean;
};

export function resolveContextWindow(model: string): ContextWindow {
  const name = model.trim();
  for (const rule of RULES) {
    if (rule.model.test(name)) return { window: rule.window, assumed: false };
  }
  return { window: DEFAULT_CONTEXT_WINDOW, assumed: true };
}
