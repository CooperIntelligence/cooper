import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSettings, readSettingsDocument, userConfigFile, writeSettingsDocument } from "../src/settings.js";

let dir: string;
let home: string;

function write(content: string): void {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(userConfigFile(home), content, "utf8");
}

function load() {
  return loadSettings({ home });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cooper-settings-"));
  home = path.join(dir, "home");
});

it("refuses to overwrite config changed since the editor opened", () => {
  write('{"model":"original"}');
  const document = readSettingsDocument(home);
  write('{"model":"external edit"}');

  expect(() => writeSettingsDocument(document, { model: "stale draft" })).toThrow(/config\.json changed/);
  expect(load().settings?.model).toBe("external edit");
  expect(fs.readdirSync(home)).toEqual(["config.json"]);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("loadSettings", () => {
  it("treats a missing file as an empty layer", () => {
    const settings = load();
    expect(settings.settings).toBeNull();
    expect(settings.file).toBeNull();
    expect(settings.warnings).toEqual([]);
  });

  it("loads every field, including the top-level provider credentials", () => {
    write(
      JSON.stringify({
        apiKey: "sk-secret",
        baseURL: "https://gw/v1",
        protocol: "anthropic-messages",
        model: "claude-sonnet-5-5",
        maxOutputTokens: 8000,
        showReasoning: true,
        mode: "plan",
        context: { window: 128000, reserveOutputTokens: 4096, compact: false },
      }),
    );

    const settings = load();
    expect(settings.settings).toEqual({
      apiKey: "sk-secret",
      baseURL: "https://gw/v1",
      protocol: "anthropic-messages",
      model: "claude-sonnet-5-5",
      maxOutputTokens: 8000,
      showReasoning: true,
      mode: "plan",
      context: { window: 128000, reserveOutputTokens: 4096, compact: false },
    });
    expect(settings.file).toBe(userConfigFile(home));
    expect(settings.warnings).toEqual([]);
  });

  it("accepts both protocols and rejects unknown ones", () => {
    write(JSON.stringify({ protocol: "openai-chat" }));
    expect(load().settings?.protocol).toBe("openai-chat");

    write(JSON.stringify({ protocol: "openai-responses" }));
    expect(() => load()).toThrow(/protocol/);
  });

  it("rejects malformed JSON with the file path", () => {
    write("{ nope");
    expect(() => load()).toThrow(/Invalid JSON in .*config\.json/);
  });

  it("rejects wrong value types with the field name", () => {
    write(JSON.stringify({ model: 42 }));
    expect(() => load()).toThrow(/model/);
  });

  it("ignores a legacy auto default with migration guidance", () => {
    write(JSON.stringify({ mode: "auto", model: "m" }));
    expect(load().settings).toEqual({ model: "m" });
    expect(load().warnings).toEqual([
      expect.stringMatching(/mode "auto".*ignored.*--mode auto/),
    ]);
  });

  it("rejects other invalid mode defaults", () => {
    write(JSON.stringify({ mode: "always" }));
    expect(() => load()).toThrow(/mode/);
  });

  it("rejects a non-object top level", () => {
    write("[]");
    expect(() => load()).toThrow(/expected a JSON object/);
  });

  it("warns about unknown keys without failing", () => {
    write(JSON.stringify({ model: "m", contex: { window: 1 } }));
    const settings = load();
    expect(settings.settings).toEqual({ model: "m" });
    expect(settings.warnings.some((w) => w.includes('"contex"'))).toBe(true);
  });

  it("accepts apiKey and warns about other secret fields without revealing them", () => {
    write(
      JSON.stringify({
        env: { COOPER_API_KEY: "sk-legacy" },
        apiKey: "sk-kept",
        token: "sk-misplaced",
        model: "m",
      }),
    );

    const settings = load();
    expect(settings.settings).toEqual({
      apiKey: "sk-kept",
      model: "m",
    });
    expect(settings.warnings).toEqual([
      expect.stringMatching(/"env" is no longer supported/),
      expect.stringMatching(/"token" looks like a secret/),
    ]);
    expect(JSON.stringify(settings.warnings)).not.toContain("sk-");
  });

  it("accepts a UTF-8 BOM", () => {
    write("﻿" + JSON.stringify({ model: "m" }));
    expect(load().settings).toEqual({ model: "m" });
  });

  it("resolves the config path from the injected home only", () => {
    expect(userConfigFile(home)).toBe(path.join(home, "config.json"));
  });
});
