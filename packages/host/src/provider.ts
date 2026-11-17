import {
  AnthropicProvider,
  OpenAICompatibleProvider,
  OpenAIResponsesProvider,
  type Provider,
} from "@cooper/core";
import type { Config } from "./config.js";

/** Builds the adapter for the effective provider settings. */
export function createProvider(
  config: Config,
  options: { allowLegacyThinking?: boolean } = {},
): Provider {
  // The SDKs can read ambient options such as custom authorization headers
  // even when an explicit endpoint and API key are supplied. Isolate their
  // synchronous constructors without changing the environment of tools.
  const prefix = config.protocol === "anthropic-messages" ? "ANTHROPIC_" : "OPENAI_";
  const sdkEnvironment = Object.entries(process.env).filter(
    ([name]) => name.toUpperCase().startsWith(prefix),
  );
  try {
    for (const [name] of sdkEnvironment) delete process.env[name];
    const modelOptions = config.modelSelection?.tier && !config.tierFallback
      ? config.modelSelection : undefined;
    const fallback = config.modelTiers?.fallback;
    if (config.protocol === "anthropic-messages") {
      return new AnthropicProvider({
        apiKey: config.apiKey,
        baseURL: config.baseURL,
        maxTokens: fallback?.maxOutputTokens ?? config.maxOutputTokens,
        modelOptions,
        allowLegacyThinking: options.allowLegacyThinking,
      });
    }
    if (config.protocol === "openai-responses") {
      return new OpenAIResponsesProvider({
        apiKey: config.apiKey,
        baseURL: config.baseURL,
        maxOutputTokens: fallback ? fallback.maxOutputTokens
          : config.sources.maxOutputTokens === "config" ? config.maxOutputTokens : undefined,
        modelOptions,
        requestReasoningSummary: config.showReasoning,
      });
    }
    return new OpenAICompatibleProvider({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      modelOptions: modelOptions ?? (config.context.maxOutputTokens ? config.modelSelection : undefined),
    });
  } finally {
    for (const [name, value] of sdkEnvironment) {
      if (value !== undefined) process.env[name] = value;
    }
  }
}
