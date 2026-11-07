import { describe, expect, it } from "vitest";
import { parseArgs, resolveMode } from "../src/args.js";

describe("parseArgs", () => {
  it("defaults to the interactive TUI", () => {
    expect(parseArgs([])).toEqual({
      mode: undefined,
      cwd: undefined,
      prompt: null,
      showReasoning: false,
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
