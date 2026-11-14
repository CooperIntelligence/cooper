import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  IncompleteConfigError,
  loadConfig,
} from "../src/config.js";
import { prepareTools } from "../src/mcp.js";

describe("loadConfig", () => {
  let home: string;
  const connection = {
    protocol: "openai-chat",
    model: "test-model",
    baseURL: "https://gateway.example/v1",
    apiKey: "test-key",
  };

  function writeConfig(value: unknown): void {
    fs.writeFileSync(path.join(home, "config.json"), JSON.stringify(value), "utf8");
  }

  it("registers web search only when user settings and a valid credential enable it", async () => {
    const toolsForConfig = async () => {
      const config = loadConfig({ home });
      const prepared = await prepareTools({
        root: home, home, explicit: [], loadProject: false,
        webSearchApiKey: config.webSearchApiKey,
      });
      await prepared.close();
      return prepared.tools.map((tool) => tool.name);
    };
    vi.stubEnv("TAVILY_API_KEY", "tvly-test");
    writeConfig(connection);
    expect(await toolsForConfig()).toContain("web_fetch");
    expect(await toolsForConfig()).not.toContain("web_search");
    writeConfig({ ...connection, webSearch: { provider: "tavily" } });
    expect(await toolsForConfig()).toContain("web_search");
    vi.stubEnv("TAVILY_API_KEY", undefined);
    expect(await toolsForConfig()).not.toContain("web_search");
    expect(loadConfig({ home }).settingsWarnings).toEqual([expect.stringContaining("TAVILY_API_KEY")]);
    writeConfig({ ...connection, webSearch: { provider: "invalid" } });
    expect(loadConfig({ home }).settingsWarnings).toEqual([expect.stringContaining("invalid webSearch")]);
  });

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "cooper-config-"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("loads provider settings from config.json and supplies other defaults", () => {
    writeConfig(connection);
    const config = loadConfig({ home });
    expect(config).toMatchObject(connection);
    expect(config.maxOutputTokens).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
    expect(config.context.window).toBe(200_000);
    expect(config.contextWindowAssumed).toBe(true);
    const defaultShells: Partial<Record<NodeJS.Platform, string>> = {
      win32: "powershell",
      linux: "bash",
      darwin: "zsh",
    };
    expect(config.shell.kind).toBe(defaultShells[process.platform] ?? "sh");
    expect(config.sources).toMatchObject({
      protocol: "config", model: "config", baseURL: "config", apiKey: "config",
    });
    expect(config.settingsFile).toBe(path.join(home, "config.json"));
  });

  it("resolves a configured shell and reports the config source", () => {
    const kind = process.platform === "win32" ? "cmd" : "sh";
    writeConfig({ ...connection, shell: { kind } });
    const config = loadConfig({ home });
    expect(config.shell.kind).toBe(kind);
    expect(path.isAbsolute(config.shell.executable)).toBe(true);
    expect(config.sources.shell).toBe("config");
  });

  it("ignores ambient overrides and keeps the saved key out of the process environment", () => {
    vi.stubEnv("COOPER_PROTOCOL", "anthropic-messages");
    vi.stubEnv("COOPER_MODEL", "env-model");
    vi.stubEnv("COOPER_BASE_URL", "https://ambient.example/v1");
    vi.stubEnv("COOPER_API_KEY", undefined);
    vi.stubEnv("COOPER_CONTEXT_WINDOW", "1234");
    writeConfig(connection);

    const config = loadConfig({ home });
    expect(config).toMatchObject(connection);
    expect(config.context.window).toBe(200_000);
    expect(process.env.COOPER_API_KEY).toBeUndefined();
  });

  it("reports every missing field even when the ambient environment is complete", () => {
    vi.stubEnv("COOPER_PROTOCOL", "openai-chat");
    vi.stubEnv("COOPER_MODEL", "env-model");
    vi.stubEnv("COOPER_BASE_URL", "https://ambient.example/v1");
    vi.stubEnv("COOPER_API_KEY", "ambient-key");

    expect(() => loadConfig({ home })).toThrow(IncompleteConfigError);
    expect(() => loadConfig({ home })).toThrow(/missing: protocol, model, baseURL, apiKey/);
  });

  it("keeps the existing provider fields available to onboarding", () => {
    const { model: _model, ...partial } = connection;
    writeConfig({ ...partial, context: { window: 32_768 } });

    expect(() => loadConfig({ home })).toThrow(
      expect.objectContaining({
        missing: ["model"],
        settings: { ...partial, model: undefined, contextWindow: 32_768 },
      }),
    );
  });

  it("ignores the legacy env object and offers migration guidance", () => {
    writeConfig({
      protocol: connection.protocol,
      model: connection.model,
      env: { COOPER_API_KEY: "old-key", COOPER_BASE_URL: "https://old.example" },
    });
    expect(() => loadConfig({ home })).toThrow(
      expect.objectContaining({
        missing: ["baseURL", "apiKey"],
        warnings: [expect.stringMatching(/"env" is no longer supported/)],
      }),
    );
  });

  it("reads optional preferences and reports their sources", () => {
    writeConfig({
      ...connection,
      protocol: "anthropic-messages",
      mode: "plan",
      maxOutputTokens: 1234,
      showReasoning: true,
      context: { window: 111_000, reserveOutputTokens: 2048, compact: false, summaryModel: "small" },
      unknownSetting: 1,
    });
    const config = loadConfig({ home });
    expect(config).toMatchObject({
      protocol: "anthropic-messages",
      defaultMode: "plan",
      maxOutputTokens: 1234,
      showReasoning: true,
      contextWindowAssumed: false,
      context: { window: 111_000, reserveOutputTokens: 2048, enabled: false, summaryModel: "small" },
    });
    expect(config.sources["context.window"]).toBe("config");
    expect(config.settingsWarnings).toEqual([expect.stringContaining("unknownSetting")]);
  });
});
