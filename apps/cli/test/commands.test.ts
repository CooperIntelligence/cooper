import { describe, expect, it } from "vitest";
import {
  commandHelp,
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

  it("reports unknown slash commands instead of sending them to the model", () => {
    expect(parseCommand("/unknown thing")).toEqual({
      kind: "unknown",
      name: "unknown",
    });
    expect(parseCommand("/")).toEqual({ kind: "unknown", name: "" });
  });
});

describe("command metadata", () => {
  it("identifies mode commands", () => {
    expect(isModeCommand("plan")).toBe(true);
    expect(isModeCommand("ask")).toBe(true);
    expect(isModeCommand("auto")).toBe(true);
    expect(isModeCommand("help")).toBe(false);
  });

  it("describes modes and renders help for the current mode", () => {
    expect(modeDescription("plan")).toBe("plan (read-only)");
    expect(modeDescription("ask")).toBe("ask (approve writes and commands)");
    expect(modeDescription("auto")).toBe("auto (auto-approve ALL tools)");

    const help = commandHelp("plan");
    expect(help).toContain("current mode: plan (read-only)");
    expect(help).toContain("/plan");
    expect(help).toContain("/ask");
    expect(help).toContain("/auto");
  });
});
