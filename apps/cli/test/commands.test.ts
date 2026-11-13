import { describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import {
  COMMANDS,
  commandArgsOf,
  commandHelp,
  completeCommand,
  filterCommands,
  formatMcp,
  formatSessions,
  formatStatus,
  formatTools,
  isModeCommand,
  modeDescription,
  parseCommand,
} from "../src/commands.js";

describe("parseCommand", () => {
  it("leaves ordinary prompts untouched", () => {
    expect(parseCommand("inspect the repo")).toEqual({
      kind: "prompt",
      text: "inspect the repo",
    });
    expect(parseCommand("what is /plan?")).toEqual({
      kind: "prompt",
      text: "what is /plan?",
    });
  });

  it("parses mode and help commands case-insensitively", () => {
    expect(parseCommand("/plan")).toEqual({
      kind: "command",
      name: "plan",
      args: "",
    });
    expect(parseCommand("  /PLAN  ")).toEqual({
      kind: "command",
      name: "plan",
      args: "",
    });
    expect(parseCommand("/auto please")).toEqual({
      kind: "command",
      name: "auto",
      args: "please",
    });
    expect(parseCommand("/help")).toEqual({
      kind: "command",
      name: "help",
      args: "",
    });
  });

  it("resolves aliases to the canonical command", () => {
    expect(parseCommand("/new")).toEqual({
      kind: "command",
      name: "clear",
      args: "",
    });
    expect(parseCommand("/reset extra")).toEqual({
      kind: "command",
      name: "clear",
      args: "extra",
    });
    expect(parseCommand("/CLEAR")).toEqual({
      kind: "command",
      name: "clear",
      args: "",
    });
  });

  it("parses the first batch of operational commands", () => {
    for (const name of ["clear", "compact", "sessions", "resume", "mcp", "tools", "skills", "skill", "config", "reload", "exit"] as const) {
      expect(parseCommand(`/${name}`)).toEqual({
        kind: "command",
        name,
        args: "",
      });
    }
  });

  it("reports unknown slash commands instead of sending them to the model", () => {
    expect(parseCommand("/unknown thing")).toEqual({
      kind: "unknown",
      name: "unknown",
    });
    expect(parseCommand("/")).toEqual({ kind: "unknown", name: "" });
  });
});

describe("command registry", () => {
  it("has unique names and aliases", () => {
    const seen = new Set<string>();
    for (const spec of COMMANDS) {
      expect(seen.has(spec.name)).toBe(false);
      seen.add(spec.name);
      for (const alias of spec.aliases) {
        expect(seen.has(alias)).toBe(false);
        seen.add(alias);
      }
    }
  });

  it("identifies mode commands", () => {
    expect(isModeCommand("plan")).toBe(true);
    expect(isModeCommand("ask")).toBe(true);
    expect(isModeCommand("auto")).toBe(true);
    expect(isModeCommand("help")).toBe(false);
    expect(isModeCommand("clear")).toBe(false);
  });

  it("describes modes and renders help for every registered command", () => {
    expect(modeDescription("plan")).toBe("plan (read-only)");
    expect(modeDescription("auto")).toBe("auto (auto-approve ALL tools)");
    expect(modeDescription("ask")).toBe("ask (approve writes and commands)");

    const help = commandHelp("plan");
    expect(help).toContain("current mode: plan (read-only)");
    for (const spec of COMMANDS) {
      expect(help).toContain(spec.usage);
    }
    expect(help).toContain("/clear");
    expect(help).toContain("aliases /new /reset");
    expect(help).toContain("/resume <id>");
  });
});

describe("filterCommands", () => {
  it("returns nothing for non-slash input", () => {
    expect(filterCommands("")).toEqual([]);
    expect(filterCommands("hello")).toEqual([]);
    expect(filterCommands("a /help")).toEqual([]);
  });

  it("lists every command for a bare slash", () => {
    expect(filterCommands("/")).toEqual([...COMMANDS]);
    expect(filterCommands("/ ")).toEqual([...COMMANDS]);
  });

  it("matches name and alias prefixes case-insensitively", () => {
    // `/re` matches `resume`, `reload`, and the `reset` alias for `clear`.
    expect(filterCommands("/re").map((spec) => spec.name)).toEqual([
      "clear",
      "resume",
      "reload",
    ]);
    expect(filterCommands("/resu").map((spec) => spec.name)).toEqual([
      "resume",
    ]);
    expect(filterCommands("/RESU").map((spec) => spec.name)).toEqual([
      "resume",
    ]);
    expect(filterCommands("/ne").map((spec) => spec.name)).toEqual(["clear"]);
    expect(filterCommands("/reset").map((spec) => spec.name)).toEqual([
      "clear",
    ]);
  });

  it("matches multiple commands on a shared prefix", () => {
    expect(filterCommands("/c").map((spec) => spec.name)).toEqual([
      "clear",
      "compact",
      "config",
    ]);
    expect(filterCommands("/s").map((spec) => spec.name)).toEqual([
      "sessions",
      "skill",
      "skills",
      "status",
    ]);
  });

  it("ignores args after the command token when filtering", () => {
    expect(filterCommands("/resume 2026-11-09").map((s) => s.name)).toEqual([
      "resume",
    ]);
    expect(filterCommands("/mcp extra").map((s) => s.name)).toEqual(["mcp"]);
  });

  it("returns nothing when the prefix matches no command", () => {
    expect(filterCommands("/zzz")).toEqual([]);
  });
});

describe("commandArgsOf / completeCommand", () => {
  it("extracts args after the slash token", () => {
    expect(commandArgsOf("/resume")).toBe("");
    expect(commandArgsOf("/resume ")).toBe("");
    expect(commandArgsOf("/resume abc def")).toBe("abc def");
    expect(commandArgsOf("not-a-command")).toBe("");
  });

  it("completes to the canonical name and keeps typed args", () => {
    const resume = COMMANDS.find((spec) => spec.name === "resume");
    const help = COMMANDS.find((spec) => spec.name === "help");
    const clear = COMMANDS.find((spec) => spec.name === "clear");
    if (!resume || !help || !clear) throw new Error("missing specs");

    // Placeholder usage gets a trailing space for the argument.
    expect(completeCommand("/re", resume)).toBe("/resume ");
    // No placeholder: bare name.
    expect(completeCommand("/he", help)).toBe("/help");
    // Typed args survive completion (alias rewritten to canonical).
    expect(completeCommand("/ne keep", clear)).toBe("/clear keep");
    // Args already present are not doubled with a placeholder space.
    expect(completeCommand("/resume abc", resume)).toBe("/resume abc");
  });
});

describe("command formatters", () => {
  it("formats an empty session list", () => {
    expect(formatSessions([])).toContain("No saved sessions");
  });

  it("formats session rows newest first as given", () => {
    const text = formatSessions([
      {
        id: "20261109-120000-abc",
        file: "/tmp/20261109-120000-abc.jsonl",
        cwd: "/work",
        model: "gpt-4o-mini",
        createdAt: "2026-11-09T12:00:00.000Z",
        updatedAt: "2026-11-09T12:00:00.000Z",
        preview: "fix the tests",
      },
    ]);
    expect(text).toContain("20261109-120000-abc");
    expect(text).toContain("fix the tests");
    expect(text).toContain("cooper --resume <id>");
  });

  it("formats MCP status with failures and warnings", () => {
    const text = formatMcp({
      sources: ["~/.cooper/mcp.json"],
      statuses: [
        { name: "fs", ok: true, toolCount: 12 },
        { name: "bad", ok: false, toolCount: 0, error: "spawn failed" },
      ],
      warnings: ["duplicate tool name ignored"],
    });
    expect(text).toContain("~/.cooper/mcp.json");
    expect(text).toContain("fs  ok · 12 tool(s)");
    expect(text).toContain("bad  failed · spawn failed");
    expect(text).toContain("duplicate tool name ignored");
  });

  it("formats tools with capability labels", () => {
    const text = formatTools([
      { name: "read_file", capabilities: ["read"] },
      { name: "write_file", capabilities: ["write"] },
      { name: "mcp__fs__ls", capabilities: ["execute"] },
    ]);
    expect(text).toContain("3 tool(s)");
    expect(text).toContain("read_file");
    expect(text).toContain("read");
    expect(text).toContain("mcp__fs__ls");
    expect(text).toContain("execute");
  });
});

describe("formatStatus", () => {
  const baseConfig: Config = {
    protocol: "anthropic-messages",
    apiKey: "secret-key",
    baseURL: "https://gateway.example/v1",
    model: "claude-sonnet-5-5",
    maxOutputTokens: 64_000,
    context: { window: 200_000, reserveOutputTokens: 16_384, enabled: true },
    contextWindowAssumed: false,
    showReasoning: false,
    defaultMode: undefined,
    shell: { kind: "sh", executable: "/bin/sh" },
    sources: {
      protocol: "config",
      model: "config",
      baseURL: "config",
      apiKey: "config",
      maxOutputTokens: "default",
      showReasoning: "flag",
      "context.window": "config",
    },
    settingsWarnings: [],
    settingsFile: "/home/u/.cooper/config.json",
  };

  it("shows the effective mode, values, and each value's source", () => {
    const text = formatStatus({
      config: baseConfig,
      mode: "plan",
      modeSource: "config",
      contextTokens: 25_000,
    });
    expect(text).toContain("Mode: plan (config file)");
    expect(text).toContain("Context usage (estimated): 25000 / 200000 tokens (12.5%)");
    expect(text).toContain("sh (/bin/sh)");
    expect(text).toContain("anthropic-messages");
    expect(text).toContain("claude-sonnet-5-5");
    expect(text).toContain("flag");
    expect(text).toMatch(/apiKey\s+set\s+config file/);
    // The key value itself must never appear.
    expect(text).not.toContain("secret-key");
    expect(text).toContain("config file");
    expect(text).toContain("Settings file: /home/u/.cooper/config.json");
  });

  it("marks an assumed context window and a missing settings file", () => {
    const text = formatStatus({
      config: {
        ...baseConfig,
        contextWindowAssumed: true,
        settingsFile: null,
        settingsWarnings: ["oops"],
      },
      mode: "ask",
      modeSource: "default",
      contextTokens: 0,
    });
    expect(text).toContain("200000 (assumed)");
    expect(text).toContain("Settings file: none (built-in defaults)");
    expect(text).toContain("Warning: oops");
  });
});
