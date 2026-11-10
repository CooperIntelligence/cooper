import { describe, expect, it } from "vitest";
import {
  parseArgs,
  resolveMode,
  resolveModeForSession,
} from "../src/args.js";

describe("parseArgs", () => {
  it("defaults to the interactive TUI", () => {
    expect(parseArgs([])).toEqual({
      mode: undefined,
      cwd: undefined,
      prompt: null,
      showReasoning: false,
      resume: null,
      session: true,
      sessions: false,
      mcpConfig: [],
      mcpProject: false,
      help: false,
    });
  });

  it("reads --mode and -m", () => {
    expect(parseArgs(["--mode", "plan"]).mode).toBe("plan");
    expect(parseArgs(["-m", "auto"]).mode).toBe("auto");
    expect(parseArgs(["--mode=plan"]).mode).toBe("plan");
  });

  it("rejects an invalid or missing mode", () => {
    expect(() => parseArgs(["--mode", "yolo"])).toThrow(/Invalid --mode/);
    expect(() => parseArgs(["--mode"])).toThrow(/requires a value/);
  });

  it("reads --cwd and -C", () => {
    expect(parseArgs(["--cwd", "../app"]).cwd).toBe("../app");
    expect(parseArgs(["-C", "../app"]).cwd).toBe("../app");
    expect(parseArgs(["--cwd=../app"]).cwd).toBe("../app");
  });

  it("treats a bare argument as the prompt", () => {
    expect(parseArgs(["fix it"]).prompt).toBe("fix it");
  });

  it("reads the prompt after -p/--print", () => {
    expect(parseArgs(["-p", "hello"]).prompt).toBe("hello");
    expect(parseArgs(["--print", "hello"]).prompt).toBe("hello");
    expect(parseArgs(["--print=hello"]).prompt).toBe("hello");
  });

  it("falls back to stdin when --print has no prompt", () => {
    expect(parseArgs(["--print"]).prompt).toBe("-");
    expect(parseArgs(["-p", "-"]).prompt).toBe("-");

    const withFlag = parseArgs(["-p", "--mode", "plan"]);
    expect(withFlag.prompt).toBe("-");
    expect(withFlag.mode).toBe("plan");
  });

  it("rejects two prompts", () => {
    expect(() => parseArgs(["-p", "a", "b"])).toThrow(/extra argument/);
  });

  it("accepts a positional prompt after intervening flags", () => {
    const parsed = parseArgs(["-p", "--resume", "abc", "follow up"]);
    expect(parsed.prompt).toBe("follow up");
    expect(parsed.resume).toBe("abc");
  });

  it("rejects unknown flags", () => {
    expect(() => parseArgs(["--nope"])).toThrow(/Unknown argument/);
  });

  it("enables reasoning output with --show-reasoning", () => {
    expect(parseArgs(["--show-reasoning"]).showReasoning).toBe(true);
    expect(parseArgs(["-p", "hi"]).showReasoning).toBe(false);
  });

  it("recognises help", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs(["-h"]).help).toBe(true);
  });

  it("reads --resume and -r", () => {
    expect(parseArgs(["--resume", "abc123"]).resume).toBe("abc123");
    expect(parseArgs(["--resume=abc123"]).resume).toBe("abc123");
    expect(parseArgs(["-r", "abc123"]).resume).toBe("abc123");
  });

  it("requires an explicit session id", () => {
    expect(() => parseArgs(["--resume"])).toThrow(/requires a session id/);
    expect(() => parseArgs(["--resume= "])).toThrow(/requires a session id/);
    expect(() => parseArgs(["--resume", "-p", "hi"])).toThrow(
      /requires a session id/,
    );
  });

  it("disables persistence with --no-session", () => {
    expect(parseArgs(["--no-session"]).session).toBe(false);
    expect(parseArgs(["hi"]).session).toBe(true);
    expect(() => parseArgs(["--resume", "abc", "--no-session"])).toThrow(
      /cannot be combined/,
    );
  });

  it("lists sessions with --sessions", () => {
    expect(parseArgs(["--sessions"]).sessions).toBe(true);
    expect(() => parseArgs(["--sessions", "-p", "hi"])).toThrow(
      /cannot run a prompt/,
    );
    expect(() => parseArgs(["--sessions", "--resume", "abc"])).toThrow(
      /cannot run a prompt/,
    );
  });

  it("reads repeatable MCP config flags and the project opt-in", () => {
    expect(parseArgs(["--mcp-config", "a.json"]).mcpConfig).toEqual(["a.json"]);
    expect(
      parseArgs(["--mcp-config=a.json", "--mcp-config", "b.json"]).mcpConfig,
    ).toEqual(["a.json", "b.json"]);
    expect(parseArgs(["--mcp-project"]).mcpProject).toBe(true);
    expect(parseArgs([]).mcpProject).toBe(false);
    expect(() => parseArgs(["--mcp-config"])).toThrow(/requires a value/);
  });
});

describe("--model", () => {
  it("parses a model name for this run", () => {
    expect(parseArgs(["--model", "gpt-x"]).model).toBe("gpt-x");
    expect(parseArgs(["--model=gpt-x"]).model).toBe("gpt-x");
    expect(parseArgs([]).model).toBeUndefined();
  });

  it("rejects an empty model", () => {
    expect(() => parseArgs(["--model"])).toThrow(/requires a value/);
    expect(() => parseArgs(["--model", ""])).toThrow(/requires a name/);
  });
});

describe("resolveMode", () => {
  it("prefers the flag over the environment", () => {
    expect(resolveMode("plan", "auto")).toBe("plan");
  });

  it("falls back to COOPER_MODE", () => {
    expect(resolveMode(undefined, "auto")).toBe("auto");
  });

  it("defaults to ask", () => {
    expect(resolveMode(undefined, undefined)).toBe("ask");
    expect(resolveMode(undefined, "  ")).toBe("ask");
  });

  it("rejects an invalid COOPER_MODE", () => {
    expect(() => resolveMode(undefined, "yolo")).toThrow(/COOPER_MODE/);
  });
});

describe("resolveModeForSession", () => {
  it("prefers the flag, then the environment, then the saved mode", () => {
    expect(resolveModeForSession("auto", "plan", "ask")).toMatchObject({
      mode: "auto",
      source: "flag",
    });
    expect(resolveModeForSession(undefined, "auto", "plan")).toMatchObject({
      mode: "auto",
      source: "env",
    });
    expect(resolveModeForSession(undefined, undefined, "plan")).toMatchObject({
      mode: "plan",
      source: "session",
    });
    expect(resolveModeForSession(undefined, undefined, "ask")).toMatchObject({
      mode: "ask",
      source: "session",
    });
    expect(resolveModeForSession(undefined, undefined, null)).toMatchObject({
      mode: "ask",
      source: "default",
    });
  });

  it("never restores a saved auto mode implicitly", () => {
    expect(resolveModeForSession(undefined, undefined, "auto")).toEqual({
      mode: "ask",
      source: "default",
      sessionAutoIgnored: true,
    });
    expect(resolveModeForSession("auto", undefined, "auto")).toMatchObject({
      mode: "auto",
      source: "flag",
      sessionAutoIgnored: false,
    });
    expect(resolveModeForSession(undefined, "auto", "auto")).toMatchObject({
      mode: "auto",
      source: "env",
      sessionAutoIgnored: false,
    });
  });

  it("rejects an invalid COOPER_MODE when resuming", () => {
    expect(() =>
      resolveModeForSession(undefined, "yolo", "ask"),
    ).toThrow(/COOPER_MODE/);
  });

  it("falls back to the configured mode from settings files", () => {
    expect(resolveModeForSession(undefined, undefined, null, "plan")).toEqual({
      mode: "plan",
      source: "config",
      sessionAutoIgnored: false,
    });
    // Saved plan/ask still beats the configured default.
    expect(resolveModeForSession(undefined, undefined, "ask", "plan")).toMatchObject({
      mode: "ask",
      source: "session",
    });
    // Env beats the configured mode.
    expect(resolveModeForSession(undefined, "auto", null, "plan")).toMatchObject({
      mode: "auto",
      source: "env",
    });
  });

  it("honours a durable configured auto but never a remembered one", () => {
    expect(resolveModeForSession(undefined, undefined, "auto", "auto")).toEqual({
      mode: "auto",
      source: "config",
      sessionAutoIgnored: false,
    });
    expect(resolveModeForSession(undefined, undefined, "auto", "ask")).toEqual({
      mode: "ask",
      source: "config",
      sessionAutoIgnored: true,
    });
  });

  it("rejects an invalid configured mode", () => {
    expect(() =>
      resolveModeForSession(undefined, undefined, null, "yolo" as never),
    ).toThrow(/configured mode/);
  });
});
