import {
  AnthropicProvider,
  OpenAICompatibleProvider,
  type Provider,
} from "@cooper/core";
import type { Config } from "./config.js";

/** Builds the provider once per run; every surface shares the result. */
export function createProvider(config: Config): Provider {
  if (config.protocol === "anthropic-messages") {
    return new AnthropicProvider({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      maxTokens: config.maxOutputTokens,
    });
  }

  return new OpenAICompatibleProvider({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
  });
}
