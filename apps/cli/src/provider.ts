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
    if (config.protocol === "anthropic-messages") {
      return new AnthropicProvider({
        apiKey: config.apiKey,
        baseURL: config.baseURL,
        maxTokens: config.maxOutputTokens,
        allowLegacyThinking: options.allowLegacyThinking,
      });
    }
    if (config.protocol === "openai-responses") {
      return new OpenAIResponsesProvider({
        apiKey: config.apiKey,
        baseURL: config.baseURL,
        maxOutputTokens: config.sources.maxOutputTokens === "config" ? config.maxOutputTokens : undefined,
        requestReasoningSummary: config.showReasoning,
      });
    }
    return new OpenAICompatibleProvider({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
    });
  } finally {
    for (const [name, value] of sdkEnvironment) {
      if (value !== undefined) process.env[name] = value;
    }
  }
}
