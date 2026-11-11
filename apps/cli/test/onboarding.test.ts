import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultEndpoint,
  mergeOnboardingConfig,
  probeRequest,
  writeOnboardingConfig,
} from "../src/onboarding.js";

describe("probeRequest", () => {
  it("targets the OpenAI models listing with a bearer token", () => {
    const request = probeRequest(
      "openai-chat",
      "https://api.openai.com/v1",
      "sk-test",
    );
    expect(request.url).toBe("https://api.openai.com/v1/models");
    expect(request.headers.Authorization).toBe("Bearer sk-test");
  });

  it("targets the Anthropic models listing with x-api-key", () => {
    const request = probeRequest(
      "anthropic-messages",
      "https://api.anthropic.com",
      "sk-ant",
    );
    expect(request.url).toBe("https://api.anthropic.com/v1/models");
    expect(request.headers["x-api-key"]).toBe("sk-ant");
    expect(request.headers["anthropic-version"]).toBe("2023-06-01");
  });

  it("honours a custom base URL without doubling slashes", () => {
    const request = probeRequest(
      "openai-chat",
      "https://gateway.example/v1/",
      "k",
    );
    expect(request.url).toBe("https://gateway.example/v1/models");
  });
});

describe("defaultEndpoint", () => {
  it("returns the official URL per protocol (placeholder only)", () => {
    expect(defaultEndpoint("openai-chat")).toBe("https://api.openai.com/v1");
    expect(defaultEndpoint("anthropic-messages")).toBe(
      "https://api.anthropic.com",
    );
  });
});

describe("mergeOnboardingConfig", () => {
  const result = {
    protocol: "openai-chat" as const,
    model: "my-model",
    apiKey: "sk-new",
    baseURL: "https://api.openai.com/v1",
  };

  it("creates a complete config from scratch", () => {
    expect(mergeOnboardingConfig(null, result)).toEqual({
      protocol: "openai-chat",
      model: "my-model",
      apiKey: "sk-new",
      baseURL: "https://api.openai.com/v1",
    });
  });

  it("always overwrites model and baseURL — never leaves them missing", () => {
    const existing = {
      model: "stale-model",
      baseURL: "https://stale.example",
    };
    const merged = mergeOnboardingConfig(existing, result);
    expect(merged.model).toBe("my-model");
    expect(merged.baseURL).toBe("https://api.openai.com/v1");
  });

  it("preserves existing preferences", () => {
    const existing = {
      protocol: "anthropic-messages",
      model: "old-model",
      context: { window: 1000 },
      baseURL: "https://old.example",
    };
    const merged = mergeOnboardingConfig(existing, {
      ...result,
      protocol: "anthropic-messages",
      model: "claude-sonnet-5-5",
      baseURL: "https://new.example",
    });
    expect(merged).toEqual({
      protocol: "anthropic-messages",
      model: "claude-sonnet-5-5",
      context: { window: 1000 },
      apiKey: "sk-new",
      baseURL: "https://new.example",
    });
  });

  it("writes an explicit context window and preserves other context preferences", () => {
    expect(mergeOnboardingConfig(
      { context: { window: 128_000, compact: false, reserveOutputTokens: 2048 } },
      { ...result, contextWindow: 32_768 },
    ).context).toEqual({ window: 32_768, compact: false, reserveOutputTokens: 2048 });
  });

  it("refuses a result without baseURL instead of dropping it", () => {
    expect(() =>
      mergeOnboardingConfig(null, { ...result, baseURL: "  " }),
    ).toThrow(/baseURL/);
  });
});

describe("writeOnboardingConfig", () => {
  let dir: string;
  let home: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cooper-onboarding-"));
    home = path.join(dir, "home");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("writes a fresh complete config and returns its path", () => {
    const file = writeOnboardingConfig(home, {
      protocol: "anthropic-messages",
      model: "claude-sonnet-5-5",
      apiKey: "sk-x",
      baseURL: "https://api.anthropic.com",
    });
    expect(file).toBe(path.join(home, "config.json"));
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(parsed).toEqual({
      protocol: "anthropic-messages",
      model: "claude-sonnet-5-5",
      apiKey: "sk-x",
      baseURL: "https://api.anthropic.com",
    });
  });

  it("merges into an existing config instead of clobbering it", () => {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({ mode: "plan" }),
      "utf8",
    );

    writeOnboardingConfig(home, {
      protocol: "openai-chat",
      model: "gateway-model",
      apiKey: "sk-y",
      baseURL: "https://gw/v1",
    });

    const parsed = JSON.parse(
      fs.readFileSync(path.join(home, "config.json"), "utf8"),
    );
    expect(parsed.model).toBe("gateway-model");
    expect(parsed.mode).toBe("plan");
    expect(parsed.protocol).toBe("openai-chat");
    expect(parsed.apiKey).toBe("sk-y");
    expect(parsed.baseURL).toBe("https://gw/v1");
  });

  it("refuses to overwrite an unreadable config", () => {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, "config.json"), "{ not json", "utf8");

    expect(() =>
      writeOnboardingConfig(home, {
        protocol: "openai-chat",
        model: "m",
        apiKey: "sk-z",
        baseURL: "https://api.openai.com/v1",
      }),
    ).toThrow(/Refusing to overwrite/);
  });

  it("keeps the original config if a partial write fails", () => {
    fs.mkdirSync(home, { recursive: true });
    const file = path.join(home, "config.json");
    const original = '{"mode":"plan"}\n';
    fs.writeFileSync(file, original);

    const write = fs.writeFileSync;
    const interrupted = vi.spyOn(fs, "writeFileSync").mockImplementationOnce((target) => {
      write(target, '{"protocol":');
      throw new Error("simulated write interruption");
    });
    try {
      expect(() => writeOnboardingConfig(home, {
        protocol: "openai-chat",
        model: "m",
        apiKey: "sk-z",
        baseURL: "https://api.openai.com/v1",
      })).toThrow(/simulated write interruption/);
    } finally {
      interrupted.mockRestore();
    }
    expect(fs.readFileSync(file, "utf8")).toBe(original);
    expect(fs.readdirSync(home)).toEqual(["config.json"]);
  });
});
