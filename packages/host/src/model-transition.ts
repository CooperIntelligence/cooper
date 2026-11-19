import {
  contextInputLimit, estimateContextTokens, prepareContext, resolveContextConfig, toToolSpec,
  type Message, type Provider, type Tool,
} from "@cooper/core";
import { describeModel, type Config } from "./config.js";

export function needsResumeBudgetCheck(config: Config, saved?: Config["modelSelection"]): boolean {
  return Boolean(config.modelSelection?.tier || saved?.tier ||
    (saved && config.modelSelection && config.modelSelection.inputLimit < saved.inputLimit));
}

export function modelBudget(config: Config, messages: Message[], tools: Tool[], provider: Provider) {
  const specs = tools.map(toToolSpec);
  const context = resolveContextConfig(config.context);
  const estimated = provider.estimateInputTokens?.({ model: config.model, messages, tools: specs })
    ?? estimateContextTokens(messages, specs);
  return { estimated, limit: contextInputLimit(context), specs, context };
}

export function transitionMessage(config: Config, budget: { estimated: number; limit: number }): string {
  return `${describeModel(config)} can accept about ${budget.limit.toLocaleString("en-US")} input tokens. Current context is about ${budget.estimated.toLocaleString("en-US")} tokens.`;
}

export async function compactForModel(
  config: Config,
  provider: Provider,
  messages: Message[],
  budget: ReturnType<typeof modelBudget>,
  signal: AbortSignal,
): Promise<Message[]> {
  if (!budget.context.enabled) throw new Error("Context compaction is disabled (context.compact is false).");
  const candidate = messages.slice();
  await prepareContext({
    messages: candidate, tools: budget.specs, provider, model: config.model,
    config: budget.context, signal, useProviderEstimate: true, preserveLatestVisible: true,
  });
  return candidate;
}
