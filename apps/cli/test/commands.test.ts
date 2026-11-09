import { describe, expect, it } from "vitest";
import {
  COMMANDS,
  commandHelp,
  formatMcp,
  formatSessions,
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
    for (const name of ["clear", "compact", "sessions", "resume", "mcp", "tools", "exit"] as const) {
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
