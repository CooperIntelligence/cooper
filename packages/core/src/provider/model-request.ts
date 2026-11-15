import type { ReasoningEffort } from "../model-selection.js";
import { supportsAdaptiveThinking } from "./anthropic.js";

export function validateModelRequest(
  protocol: string,
  baseURL: string,
  model: string,
  effort: ReasoningEffort | undefined,
  field: string,
): void {
  if (effort === undefined) return;
  const host = new URL(baseURL).hostname;
  const claudeEffort = supportsAdaptiveThinking(model) ||
    /^claude-(?:opus-4[-.]5|mythos-preview)(?:[.\-[]|$)/i.test(model);
  const supported = protocol === "anthropic-messages"
    ? !["none", "minimal"].includes(effort) &&
      (host !== "api.anthropic.com" || claudeEffort)
    : !(host === "api.openai.com" && /^gpt-6-astra(?:-|$)/i.test(model) && effort === "none") &&
      !(host === "api.openai.com" && /^gpt-6[.]1-sol(?:-|$)/i.test(model) && ["none", "minimal"].includes(effort));
  if (!supported) {
    throw new Error(`${field}.reasoningEffort "${effort}" is unsupported for ${model} on ${protocol}.`);
  }
}
