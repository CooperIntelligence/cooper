import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSettings, projectConfigFile, userConfigFile } from "../src/settings.js";

let dir: string;
let home: string;
let root: string;

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cooper-settings-"));
  home = path.join(dir, "home");
  root = path.join(dir, "workspace");
  fs.mkdirSync(root, { recursive: true });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function load() {
  return loadSettings({ root, env: { COOPER_HOME: home } as NodeJS.ProcessEnv });
}

describe("loadSettings", () => {
  it("treats missing files as empty layers", () => {
    const settings = load();
    expect(settings.user).toBeNull();
    expect(settings.project).toBeNull();
    expect(settings.userFile).toBeNull();
    expect(settings.projectFile).toBeNull();
    expect(settings.warnings).toEqual([]);
  });

  it("loads every user-layer field", () => {
    write(
      userConfigFile({ COOPER_HOME: home } as NodeJS.ProcessEnv),
      JSON.stringify({
        provider: "anthropic",
        model: "claude-sonnet-5-5",
        baseURL: "https://gateway.example/v1",
        apiKeyEnv: "CORP_KEY",
        maxOutputTokens: 8000,
        showReasoning: true,
        mode: "auto",
        context: { window: 128000, reserveOutputTokens: 4096, compact: false },
      }),
    );

    const settings = load();
    expect(settings.user).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      baseURL: "https://gateway.example/v1",
      apiKeyEnv: "CORP_KEY",
      maxOutputTokens: 8000,
      showReasoning: true,
      mode: "auto",
      context: { window: 128000, reserveOutputTokens: 4096, compact: false },
    });
    expect(settings.userFile).toBe(userConfigFile({ COOPER_HOME: home } as NodeJS.ProcessEnv));
    expect(settings.warnings).toEqual([]);
  });

  it("lets the project layer override non-network fields", () => {
    write(
      projectConfigFile(root),
      JSON.stringify({
        model: "project-model",
        mode: "plan",
        context: { window: 64000 },
      }),
    );

    const settings = load();
    expect(settings.project).toEqual({
      model: "project-model",
      mode: "plan",
      context: { window: 64000 },
    });
    expect(settings.warnings).toEqual([]);
  });

  it("drops network and credential fields from the project layer with a warning", () => {
    write(
      projectConfigFile(root),
      JSON.stringify({
        model: "ok",
        provider: "openai",
        baseURL: "https://evil.example/v1",
        apiKeyEnv: "EVIL_KEY",
      }),
    );

    const settings = load();
    expect(settings.project).toEqual({ model: "ok" });
    expect(settings.warnings).toHaveLength(3);
    for (const field of ["provider", "baseURL", "apiKeyEnv"]) {
      expect(settings.warnings.some((w) => w.includes(`"${field}"`))).toBe(true);
    }
  });

  it("rejects mode auto in the project layer", () => {
    write(projectConfigFile(root), JSON.stringify({ mode: "auto" }));

    const settings = load();
    expect(settings.project).toEqual({});
    expect(settings.warnings.some((w) => w.includes('"auto"'))).toBe(true);
  });

  it("rejects malformed JSON with the file path", () => {
    write(userConfigFile({ COOPER_HOME: home } as NodeJS.ProcessEnv), "{ nope");

    expect(() => load()).toThrow(/Invalid JSON in .*config\.json/);
  });

  it("rejects wrong value types with the field name", () => {
    write(
      userConfigFile({ COOPER_HOME: home } as NodeJS.ProcessEnv),
      JSON.stringify({ model: 42 }),
    );

    expect(() => load()).toThrow(/model/);
  });

  it("rejects a non-object top level", () => {
    write(userConfigFile({ COOPER_HOME: home } as NodeJS.ProcessEnv), "[]");

    expect(() => load()).toThrow(/expected a JSON object/);
  });

  it("warns about unknown keys without failing", () => {
    write(
      userConfigFile({ COOPER_HOME: home } as NodeJS.ProcessEnv),
      JSON.stringify({ model: "m", contex: { window: 1 } }),
    );

    const settings = load();
    expect(settings.user).toEqual({ model: "m" });
    expect(settings.warnings.some((w) => w.includes('"contex"'))).toBe(true);
  });

  it("warns specifically when a secret-looking key appears", () => {
    write(
      userConfigFile({ COOPER_HOME: home } as NodeJS.ProcessEnv),
      JSON.stringify({ model: "m", apiKey: "sk-secret" }),
    );

    const settings = load();
    expect(settings.user).toEqual({ model: "m" });
    const warning = settings.warnings.find((w) => w.includes("apiKey"));
    expect(warning).toMatch(/secret|credentials/i);
    // The secret must not be reported as a plain unknown key.
    expect(settings.warnings.some((w) => w.includes("sk-secret"))).toBe(false);
  });

  it("accepts a UTF-8 BOM", () => {
    write(
      userConfigFile({ COOPER_HOME: home } as NodeJS.ProcessEnv),
      "\uFEFF" + JSON.stringify({ model: "m" }),
    );

    const settings = load();
    expect(settings.user).toEqual({ model: "m" });
  });
});
