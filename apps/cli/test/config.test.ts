import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  IncompleteConfigError,
  applyEnvFile,
  loadConfig,
  resolveProtocol,
} from "../src/config.js";

function env(values: Record<string, string>): NodeJS.ProcessEnv {
  return values as NodeJS.ProcessEnv;
}

describe("resolveProtocol", () => {
  it("defaults to the OpenAI chat protocol for empty input only", () => {
    // loadConfig never uses this path: a missing protocol is an error there.
    expect(resolveProtocol(undefined)).toBe("openai-chat");
    expect(resolveProtocol("")).toBe("openai-chat");
    expect(resolveProtocol("  ")).toBe("openai-chat");
  });

  it("accepts both supported protocols explicitly", () => {
    expect(resolveProtocol("openai-chat")).toBe("openai-chat");
    expect(resolveProtocol("Anthropic-Messages")).toBe("anthropic-messages");
  });

  it("rejects unknown protocols instead of guessing from the model", () => {
    expect(() => resolveProtocol("claude")).toThrow(/openai-chat/);
    expect(() => resolveProtocol("openai-responses")).toThrow(/protocol/);
  });
});

describe("loadConfig", () => {
  let dir: string;
  let home: string;

  /** Ambient env that satisfies every required field. */
  const full = {
    COOPER_API_KEY: "k",
    COOPER_MODEL: "m",
    COOPER_PROTOCOL: "openai-chat",
    COOPER_BASE_URL: "https://api.openai.com/v1",
  };

  function writeConfig(value: unknown): void {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify(value),
      "utf8",
    );
  }

  function load(values: Record<string, string>, overrides?: { model?: string }) {
    return loadConfig({
      env: env({ ...values }),
      home,
      overrides,
    });
  }

  function loadMissing(
    values: Record<string, string>,
    overrides?: { model?: string },
  ): IncompleteConfigError {
    try {
      load(values, overrides);
    } catch (error) {
      expect(error).toBeInstanceOf(IncompleteConfigError);
      return error as unknown as IncompleteConfigError;
    }
    throw new Error("expected IncompleteConfigError");
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cooper-config-"));
    home = path.join(dir, "home");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("loads when all four required fields resolve", () => {
    const config = load(full);
    expect(config.protocol).toBe("openai-chat");
    expect(config.model).toBe("m");
    expect(config.baseURL).toBe("https://api.openai.com/v1");
    expect(config.apiKey).toBe("k");
    expect(config.maxOutputTokens).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
    expect(config.context.window).toBe(200_000);
    expect(config.contextWindowAssumed).toBe(true);
    expect(config.sources.model).toBe("env");
    expect(config.settingsFile).toBeNull();
  });

  it("reports every missing required field in one error", () => {
    const error = loadMissing({});
    expect(error.missing).toEqual(["protocol", "baseURL", "apiKey", "model"]);
    expect(error.message).toContain("protocol");
    expect(error.message).toContain("baseURL");
    expect(error.message).toContain("apiKey");
    expect(error.message).toContain("model");
    expect(error.message).toContain("config.json");
  });

  it("does not invent protocol or baseURL from thin air", () => {
    writeConfig({ model: "m" });
    const error = loadMissing({ COOPER_API_KEY: "k" });
    expect(error.missing).toEqual(["protocol", "baseURL"]);
  });

  it("does not invent a model from the protocol", () => {
    writeConfig({
      protocol: "anthropic-messages",
      env: { COOPER_API_KEY: "k", COOPER_BASE_URL: "https://api.anthropic.com" },
    });
    const error = loadMissing({});
    expect(error.missing).toEqual(["model"]);
  });

  it("accepts the four fields from config alone", () => {
    writeConfig({
      protocol: "anthropic-messages",
      model: "claude-opus-5-5",
      env: {
        COOPER_API_KEY: "cfg-key",
        COOPER_BASE_URL: "https://api.anthropic.com",
      },
    });
    const config = load({});
    expect(config.protocol).toBe("anthropic-messages");
    expect(config.model).toBe("claude-opus-5-5");
    expect(config.baseURL).toBe("https://api.anthropic.com");
    expect(config.apiKey).toBe("cfg-key");
    expect(config.sources.protocol).toBe("config");
    expect(config.sources.model).toBe("config");
    expect(config.sources.apiKey).toBe("config-env");
    expect(config.sources.baseURL).toBe("config-env");
    expect(config.context.window).toBe(1_000_000);
  });

  it("lets the environment override the protocol and model", () => {
    writeConfig({
      protocol: "openai-chat",
      model: "config-model",
      env: { COOPER_API_KEY: "k", COOPER_BASE_URL: "https://api.openai.com/v1" },
    });
    const config = load({
      COOPER_PROTOCOL: "anthropic-messages",
      COOPER_MODEL: "env-model",
    });
    expect(config.protocol).toBe("anthropic-messages");
    expect(config.model).toBe("env-model");
    expect(config.sources.protocol).toBe("env");
    expect(config.sources.model).toBe("env");
  });

  it("applies the config env block below the ambient environment", () => {
    writeConfig({
      protocol: "openai-chat",
      model: "cfg-model",
      env: {
        COOPER_API_KEY: "config-key",
        COOPER_BASE_URL: "http://config.local",
      },
    });

    // Ambient wins over the config env block.
    const ambient = load({
      COOPER_API_KEY: "shell-key",
      COOPER_BASE_URL: "http://shell.local",
      COOPER_MODEL: "shell-model",
    });
    expect(ambient.apiKey).toBe("shell-key");
    expect(ambient.baseURL).toBe("http://shell.local");
    expect(ambient.model).toBe("shell-model");
    expect(ambient.sources.apiKey).toBe("env");
    expect(ambient.sources.baseURL).toBe("env");
    expect(ambient.sources.model).toBe("env");

    // The config env block fills the gaps and reports its own source.
    const gap = load({});
    expect(gap.apiKey).toBe("config-key");
    expect(gap.baseURL).toBe("http://config.local");
    expect(gap.model).toBe("cfg-model");
    expect(gap.sources.apiKey).toBe("config-env");
    expect(gap.sources.baseURL).toBe("config-env");
    expect(gap.sources.model).toBe("config");
  });

  it("applies flag > env > config for model", () => {
    writeConfig({
      protocol: "openai-chat",
      model: "config-model",
      env: { COOPER_API_KEY: "k", COOPER_BASE_URL: "https://api.openai.com/v1" },
    });
    expect(load({}).model).toBe("config-model");
    expect(load({ COOPER_MODEL: "env-model" }).model).toBe("env-model");
    expect(load({}, { model: "flag-model" }).model).toBe("flag-model");
    expect(
      load({ COOPER_MODEL: "env-model" }, { model: "flag-model" }).model,
    ).toBe("flag-model");
  });

  it("layers context settings below env", () => {
    writeConfig({
      protocol: "openai-chat",
      model: "m",
      context: { window: 111_000, reserveOutputTokens: 2048 },
      maxOutputTokens: 1234,
      env: { COOPER_API_KEY: "k", COOPER_BASE_URL: "https://api.openai.com/v1" },
    });

    const config = load({});
    expect(config.context.window).toBe(111_000);
    expect(config.context.reserveOutputTokens).toBe(2048);
    expect(config.maxOutputTokens).toBe(1234);
    expect(config.sources["context.window"]).toBe("config");

    const withEnv = load({ COOPER_CONTEXT_WINDOW: "333000" });
    expect(withEnv.context.window).toBe(333_000);
    expect(withEnv.sources["context.window"]).toBe("env");
  });

  it("reads defaultMode from the config file", () => {
    writeConfig({
      mode: "plan",
      protocol: "openai-chat",
      model: "m",
      env: { COOPER_API_KEY: "k", COOPER_BASE_URL: "https://api.openai.com/v1" },
    });
    expect(load({}).defaultMode).toBe("plan");
    expect(load({}).sources.model).toBe("config");
  });

  it("propagates settings-file warnings and the file path", () => {
    writeConfig({
      protocol: "openai-chat",
      model: "m",
      nope: 1,
      env: { COOPER_API_KEY: "k", COOPER_BASE_URL: "https://api.openai.com/v1" },
    });
    const config = load({});
    expect(config.model).toBe("m");
    expect(config.settingsWarnings.some((w) => w.includes("nope"))).toBe(true);
    expect(config.settingsFile).toBe(path.join(home, "config.json"));
  });
});

describe("applyEnvFile", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cooper-envfile-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("loads dotenv syntax and overrides the ambient environment", () => {
    const file = path.join(dir, "run.env");
    fs.writeFileSync(
      file,
      "# comment\nCOOPER_API_KEY=file-key\nQUOTED=\"with space\"\n",
      "utf8",
    );
    const target: NodeJS.ProcessEnv = { COOPER_API_KEY: "shell-key" };

    applyEnvFile(file, target);

    expect(target.COOPER_API_KEY).toBe("file-key");
    expect(target.QUOTED).toBe("with space");
  });

  it("fails loudly when the file is missing", () => {
    expect(() => applyEnvFile(path.join(dir, "nope.env"), {})).toThrow(
      /Env file not found/,
    );
  });
});
