import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

describe("loadConfig settings layers", () => {
  let dir: string;
  let home: string;
  let root: string;

  function writeJson(file: string, value: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value), "utf8");
  }

  function load(
    values: Record<string, string>,
    overrides?: { model?: string },
  ) {
    return loadConfig({
      loadEnv: false,
      env: env({ COOPER_HOME: home, ...values }),
      root,
      overrides,
    });
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cooper-config-"));
    home = path.join(dir, "home");
    root = path.join(dir, "workspace");
    fs.mkdirSync(root, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("applies flag > env > project > user > default for model", () => {
    writeJson(path.join(home, "config.json"), { model: "user-model" });
    writeJson(path.join(root, ".cooper", "config.json"), { model: "project-model" });

    expect(load({ COOPER_API_KEY: "k" }).model).toBe("project-model");
    expect(load({ COOPER_API_KEY: "k", COOPER_MODEL: "env-model" }).model).toBe(
      "env-model",
    );
    expect(
      load({ COOPER_API_KEY: "k" }, { model: "flag-model" }).model,
    ).toBe("flag-model");
  });

  it("lets the user layer beat the default when no project file exists", () => {
    writeJson(path.join(home, "config.json"), { model: "user-model" });

    const config = load({ COOPER_API_KEY: "k" });
    expect(config.model).toBe("user-model");
    expect(config.sources.model).toBe("user");
  });

  it("records the source of each value", () => {
    writeJson(path.join(home, "config.json"), { model: "user-model" });
    writeJson(path.join(root, ".cooper", "config.json"), {
      maxOutputTokens: 1234,
    });

    const config = load({ COOPER_API_KEY: "k", COOPER_PROVIDER: "anthropic" });
    expect(config.sources.provider).toBe("env");
    expect(config.sources.model).toBe("user");
    expect(config.sources.maxOutputTokens).toBe("project");
    expect(config.sources.apiKey).toBe("env");
  });

  it("keeps baseURL in env/user only and lets env win", () => {
    writeJson(path.join(home, "config.json"), {
      baseURL: "http://user.local/v1",
    });

    expect(load({ COOPER_API_KEY: "k" }).baseURL).toBe("http://user.local/v1");
    expect(
      load({ COOPER_API_KEY: "k", COOPER_BASE_URL: "http://env.local/v1" })
        .baseURL,
    ).toBe("http://env.local/v1");
    expect(load({ COOPER_API_KEY: "k" }).sources.baseURL).toBe("user");
  });

  it("resolves the API key through the apiKeyEnv pointer first", () => {
    writeJson(path.join(home, "config.json"), { apiKeyEnv: "CORP_KEY" });

    const config = load({ CORP_KEY: "corp-key", COOPER_API_KEY: "fallback" });
    expect(config.apiKey).toBe("corp-key");
    expect(load({ COOPER_API_KEY: "fallback" }).apiKey).toBe("fallback");
  });

  it("names the pointed-at variable when it is missing", () => {
    writeJson(path.join(home, "config.json"), { apiKeyEnv: "CORP_KEY" });

    expect(() => load({})).toThrow(/Set CORP_KEY/);
  });

  it("layers context settings below env", () => {
    writeJson(path.join(home, "config.json"), {
      context: { window: 111_000, reserveOutputTokens: 2048 },
    });
    writeJson(path.join(root, ".cooper", "config.json"), {
      context: { window: 222_000 },
    });

    const config = load({ COOPER_API_KEY: "k" });
    expect(config.context.window).toBe(222_000);
    expect(config.context.reserveOutputTokens).toBe(2048);
    expect(config.sources["context.window"]).toBe("project");
    expect(config.sources["context.reserveOutputTokens"]).toBe("user");

    const withEnv = load({
      COOPER_API_KEY: "k",
      COOPER_CONTEXT_WINDOW: "333000",
    });
    expect(withEnv.context.window).toBe(333_000);
    expect(withEnv.sources["context.window"]).toBe("env");
  });

  it("reads defaultMode from the settings files, project first", () => {
    writeJson(path.join(home, "config.json"), { mode: "auto" });
    expect(load({ COOPER_API_KEY: "k" }).defaultMode).toBe("auto");

    writeJson(path.join(root, ".cooper", "config.json"), { mode: "plan" });
    expect(load({ COOPER_API_KEY: "k" }).defaultMode).toBe("plan");
  });

  it("propagates settings-file warnings", () => {
    fs.mkdirSync(path.join(home), { recursive: true });
    fs.writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({ model: "m", nope: 1 }),
      "utf8",
    );

    const config = load({ COOPER_API_KEY: "k" });
    expect(config.model).toBe("m");
    expect(config.settingsWarnings.some((w) => w.includes("nope"))).toBe(true);
  });
});
