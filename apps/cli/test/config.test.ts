import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  loadConfig,
  resolveProvider,
} from "../src/config.js";

function env(values: Record<string, string>): NodeJS.ProcessEnv {
  return values as NodeJS.ProcessEnv;
}

describe("resolveProvider", () => {
  it("defaults to the OpenAI-compatible protocol", () => {
    expect(resolveProvider(undefined)).toBe("openai");
    expect(resolveProvider("")).toBe("openai");
    expect(resolveProvider("  ")).toBe("openai");
  });

  it("accepts both supported protocols explicitly", () => {
    expect(resolveProvider("openai")).toBe("openai");
    expect(resolveProvider("Anthropic")).toBe("anthropic");
  });

  it("rejects unknown protocols instead of guessing from the model", () => {
    expect(() => resolveProvider("claude")).toThrow(/COOPER_PROVIDER/);
  });
});

describe("loadConfig", () => {
  it("uses the OpenAI-compatible defaults", () => {
    const config = loadConfig({
      loadEnv: false,
      env: env({ COOPER_API_KEY: "test-key" }),
    });

    expect(config.provider).toBe("openai");
    expect(config.model).toBe("gpt-4o-mini");
    expect(config.maxOutputTokens).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
    expect(config.context.window).toBe(128_000);
  });

  it("uses Anthropic defaults and the Anthropic key fallback", () => {
    const config = loadConfig({
      loadEnv: false,
      env: env({
        COOPER_PROVIDER: "anthropic",
        ANTHROPIC_API_KEY: "test-key",
      }),
    });

    expect(config.provider).toBe("anthropic");
    expect(config.apiKey).toBe("test-key");
    expect(config.model).toBe("claude-opus-5-5");
    expect(config.context.window).toBe(1_000_000);
  });

  it("lets COOPER_MODEL and COOPER_MAX_OUTPUT_TOKENS override defaults", () => {
    const config = loadConfig({
      loadEnv: false,
      env: env({
        COOPER_PROVIDER: "anthropic",
        COOPER_API_KEY: "test-key",
        ANTHROPIC_BASE_URL: "http://localhost:1234",
        COOPER_MODEL: "claude-sonnet-5-5",
        COOPER_MAX_OUTPUT_TOKENS: "2048",
      }),
    });

    expect(config.model).toBe("claude-sonnet-5-5");
    expect(config.baseURL).toBe("http://localhost:1234");
    expect(config.maxOutputTokens).toBe(2048);
  });

  it("prefers the provider-specific endpoint over a generic override", () => {
    const config = loadConfig({
      loadEnv: false,
      env: env({
        COOPER_PROVIDER: "anthropic",
        ANTHROPIC_API_KEY: "test-key",
        ANTHROPIC_BASE_URL: "http://anthropic.local",
        COOPER_BASE_URL: "http://openai.local/v1",
      }),
    });

    expect(config.baseURL).toBe("http://anthropic.local");
  });

  it("requires a key for the selected provider", () => {
    expect(() =>
      loadConfig({
        loadEnv: false,
        env: env({ COOPER_PROVIDER: "anthropic", OPENAI_API_KEY: "nope" }),
      }),
    ).toThrow(/ANTHROPIC_API_KEY/);
  });
});
