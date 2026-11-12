import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { permissionModeNotice } from "../src/runtime-notice.js";
import {
  SessionWriter,
  createSession,
  findSessionFile,
  listSessions,
  loadSession,
  newSessionId,
  resumeSession,
  sameWorkspace,
  sessionsDir,
  workspaceKey,
} from "../src/session.js";
import type { Message } from "../src/types.js";

const roots: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

function makeWorkspace(): { home: string; cwd: string } {
  return { home: tempDir("cooper-home-"), cwd: tempDir("cooper-ws-") };
}

afterEach(() => {
  for (const dir of roots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const toolCall = {
  id: "call_1",
  name: "read_file",
  arguments: JSON.stringify({ path: "a.ts" }),
};

const toolUi = {
  toolName: "read_file",
  summary: "read a.ts",
  isError: false,
  denied: false,
  durationMs: 7,
};

describe("session ids and paths", () => {
  it("generates sortable ids with a random suffix", () => {
    expect(newSessionId(new Date("2026-01-02T03:04:05Z"))).toMatch(
      /^\d{8}-\d{6}-[0-9a-f]{6}$/,
    );
  });

  it("keys sessions by workspace and keeps the directory inspectable", () => {
    const key = workspaceKey("D:\\projects\\cooper");
    expect(key).toContain("projects-cooper");
    expect(key).toMatch(/-[0-9a-f]{8}$/);
    expect(workspaceKey("D:\\projects\\cooper")).toBe(key);
  });

  it("compares workspaces case-insensitively on Windows", () => {
    const left = path.resolve("some", "dir");
    const same =
      process.platform === "win32"
        ? left.toUpperCase()
        : left;
    expect(sameWorkspace(left, same)).toBe(true);
    expect(sameWorkspace(left, path.resolve("other"))).toBe(false);
  });
});

describe("SessionWriter", () => {
  it("creates a header-only session under the workspace directory", () => {
    const { home, cwd } = makeWorkspace();
    const writer = createSession({ cwd, model: "test-model", home });

    expect(writer.id).toMatch(/^\d{8}-\d{6}-[0-9a-f]{6}$/);
    expect(writer.file).toBe(
      path.join(sessionsDir(cwd, home), `${writer.id}.jsonl`),
    );
    expect(fs.existsSync(writer.file)).toBe(true);

    const loaded = loadSession(writer.file);
    expect(loaded.header).toMatchObject({
      version: 1,
      id: writer.id,
      cwd: path.resolve(cwd),
      model: "test-model",
    });
    expect(loaded.messages).toEqual([]);
    expect(loaded.repaired).toBe(0);
  });

  it("round-trips messages and tool UI metadata", () => {
    const { home, cwd } = makeWorkspace();
    const writer = createSession({ cwd, model: "test-model", home });

    writer.appendMessage({ role: "user", content: "inspect" });
    writer.appendMessage({
      role: "assistant",
      content: "",
      toolCalls: [toolCall],
    });
    writer.appendMessage(
      { role: "tool", toolCallId: "call_1", content: "contents" },
      toolUi,
    );
    writer.appendMessage({ role: "assistant", content: "done" });

    const loaded = loadSession(writer.file);
    expect(loaded.messages).toEqual([
      { role: "user", content: "inspect" },
      { role: "assistant", content: "", toolCalls: [toolCall] },
      { role: "tool", toolCallId: "call_1", content: "contents" },
      { role: "assistant", content: "done" },
    ]);
    expect(loaded.toolUi.get(2)).toEqual(toolUi);
    expect(loaded.repaired).toBe(0);
  });

  it("never stores system messages, which are rebuilt on resume", () => {
    const { home, cwd } = makeWorkspace();
    const writer = createSession({ cwd, model: "test-model", home });

    expect(
      writer.appendMessage({ role: "system", content: "stale prompt" }),
    ).toBeNull();
    writer.appendMessage({ role: "user", content: "hi" });

    const loaded = loadSession(writer.file);
    expect(loaded.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("uses the last checkpoint as the base and replays later messages", () => {
    const { home, cwd } = makeWorkspace();
    const writer = createSession({ cwd, model: "test-model", home });

    writer.appendMessage({ role: "user", content: "old question" });
    writer.appendMessage({ role: "assistant", content: "old answer" });
    writer.appendCheckpoint("summarize", [
      { role: "user", content: "[Earlier conversation summary]\nshort" },
    ]);
    writer.appendMessage({ role: "user", content: "next question" });

    const loaded = loadSession(writer.file);
    expect(loaded.messages).toEqual([
      { role: "user", content: "[Earlier conversation summary]\nshort" },
      { role: "user", content: "next question" },
    ]);
  });

  it("preserves tool UI metadata across a checkpoint", () => {
    const { home, cwd } = makeWorkspace();
    const writer = createSession({ cwd, model: "test-model", home });

    writer.appendMessage({ role: "user", content: "read it" });
    writer.appendMessage({
      role: "assistant",
      content: "",
      toolCalls: [toolCall],
    });
    writer.appendMessage(
      { role: "tool", toolCallId: "call_1", content: "contents" },
      toolUi,
    );
    const messages: Message[] = [
      { role: "user", content: "read it" },
      { role: "assistant", content: "", toolCalls: [toolCall] },
      { role: "tool", toolCallId: "call_1", content: "contents" },
    ];
    writer.appendCheckpoint("prune", messages);

    const loaded = loadSession(writer.file);
    expect(loaded.messages).toHaveLength(3);
    expect(loaded.toolUi.get(2)).toEqual(toolUi);
  });

  it("records agent events but ignores ephemeral reasoning and text deltas", () => {
    const { home, cwd } = makeWorkspace();
    const writer = createSession({ cwd, model: "test-model", home });
    const messages: Message[] = [];

    expect(
      writer.recordEvent(
        { type: "reasoning-delta", delta: "private chain of thought" },
        messages,
      ),
    ).toBeNull();
    expect(
      writer.recordEvent({ type: "text-delta", delta: "partial" }, messages),
    ).toBeNull();
    writer.recordEvent(
      {
        type: "assistant-done",
        content: "answer",
        toolCalls: [],
      },
      messages,
    );

    const raw = fs.readFileSync(writer.file, "utf8");
    expect(raw).not.toContain("private chain of thought");
    expect(raw).not.toContain("partial");
    expect(loadSession(writer.file).messages).toEqual([
      { role: "assistant", content: "answer" },
    ]);
  });

  it("round-trips protocol continuation data", () => {
    const { home, cwd } = makeWorkspace();
    const writer = createSession({ cwd, model: "test-model", home });
    const continuation = {
      protocol: "anthropic-messages" as const,
      endpoint: "endpoint",
      model: "test-model",
      scope: "prefix" as const,
      messageAnchor: "message-anchor",
      historyAnchor: "history-anchor",
      payload: {
        content: [
          { type: "thinking", thinking: "plan", signature: "sig-1" },
        ],
      },
    };

    writer.recordEvent(
      {
        type: "assistant-done",
        content: "answer",
        toolCalls: [],
        continuation,
      },
      [],
    );

    expect(loadSession(writer.file).messages).toEqual([
      { role: "assistant", content: "answer", continuation },
    ]);
  });

  it("records a tool result with its display summary", () => {
    const { home, cwd } = makeWorkspace();
    const writer = createSession({ cwd, model: "test-model", home });

    writer.recordEvent(
      { type: "assistant-done", content: "", toolCalls: [toolCall] },
      [],
    );
    writer.recordEvent(
      {
        type: "tool-end",
        call: toolCall,
        summary: "read a.ts",
        result: { content: "contents" },
        isError: false,
        denied: false,
        durationMs: 7,
      },
      [],
    );

    const loaded = loadSession(writer.file);
    expect(loaded.messages).toEqual([
      { role: "assistant", content: "", toolCalls: [toolCall] },
      { role: "tool", toolCallId: "call_1", content: "contents" },
    ]);
    expect(loaded.toolUi.get(1)).toEqual(toolUi);
  });

  it("restores a failed tool result from a tool event and a checkpoint", () => {
    const { home, cwd } = makeWorkspace();
    const writer = createSession({ cwd, model: "test-model", home });
    const assistant = { role: "assistant" as const, content: "", toolCalls: [toolCall] };
    const result = { role: "tool" as const, toolCallId: toolCall.id, content: "lookup failed" };
    writer.appendMessage(assistant);
    writer.recordEvent({
      type: "tool-end", call: toolCall, summary: "read a.ts", result: { content: result.content, isError: true },
      isError: true, denied: false, durationMs: 7,
    }, []);

    const expected = [assistant, { ...result, isError: true }];
    const loaded = loadSession(writer.file);
    expect(loaded.messages).toEqual(expected);
    writer.appendCheckpoint("prune", loaded.messages);
    expect(loadSession(writer.file).messages).toEqual(expected);
  });

  it("keeps legacy tool failure metadata from changing the original request history", () => {
    const { home, cwd } = makeWorkspace();
    const writer = createSession({ cwd, model: "test-model", home });
    const assistant = { role: "assistant" as const, content: "", toolCalls: [toolCall] };
    const result = { role: "tool" as const, toolCallId: toolCall.id, content: "lookup failed" };
    writer.appendMessage(assistant);
    writer.appendMessage(result, { ...toolUi, isError: true });

    const loaded = loadSession(writer.file);
    // Adding the flag retroactively would change the prefix of later signed turns.
    expect(loaded.messages).toEqual([assistant, result]);
    expect(loaded.toolUi.get(1)?.isError).toBe(true);
  });
});

describe("loadSession", () => {
  it("ignores a corrupt trailing line", () => {
    const { home, cwd } = makeWorkspace();
    const writer = createSession({ cwd, model: "test-model", home });
    writer.appendMessage({ role: "user", content: "hi" });
    fs.appendFileSync(writer.file, '{"type":"message","message":', "utf8");

    const loaded = loadSession(writer.file);
    expect(loaded.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(loaded.repaired).toBe(1);
  });

  it("drops an incomplete trailing tool-call group", () => {
    const { home, cwd } = makeWorkspace();
    const writer = createSession({ cwd, model: "test-model", home });
    const secondCall = { id: "call_2", name: "grep", arguments: "{}" };

    writer.appendMessage({ role: "user", content: "go" });
    writer.appendMessage({
      role: "assistant",
      content: "",
      toolCalls: [toolCall, secondCall],
    });
    writer.appendMessage(
      { role: "tool", toolCallId: "call_1", content: "only one" },
      toolUi,
    );

    const loaded = loadSession(writer.file);
    expect(loaded.messages).toEqual([{ role: "user", content: "go" }]);
    expect(loaded.repaired).toBe(2);
  });

  it("drops orphaned tool results", () => {
    const { home, cwd } = makeWorkspace();
    const writer = createSession({ cwd, model: "test-model", home });
    writer.appendMessage({ role: "user", content: "go" });
    writer.appendMessage({ role: "tool", toolCallId: "missing", content: "?" });

    const loaded = loadSession(writer.file);
    expect(loaded.messages).toEqual([{ role: "user", content: "go" }]);
    expect(loaded.repaired).toBe(1);
  });

  it("rejects files without a session header", () => {
    const dir = tempDir("cooper-bad-");
    const file = path.join(dir, "bad.jsonl");
    fs.writeFileSync(file, '{"type":"message","message":{"role":"user","content":"hi"}}\n');

    expect(() => loadSession(file)).toThrow(/Not a Cooper session file/);
  });

  it("rejects a future format version", () => {
    const dir = tempDir("cooper-bad-");
    const file = path.join(dir, "future.jsonl");
    fs.writeFileSync(
      file,
      JSON.stringify({
        type: "session",
        version: 99,
        id: "x",
        cwd: dir,
        model: "m",
        createdAt: new Date().toISOString(),
      }) + "\n",
    );

    expect(() => loadSession(file)).toThrow(/Unsupported session version/);
  });
});

describe("finding and resuming sessions", () => {
  it("matches an exact id or a unique prefix", () => {
    const { home, cwd } = makeWorkspace();
    const writer = createSession({
      cwd,
      model: "m",
      home,
      id: "20260101-000000-abcdef",
    });
    const dir = sessionsDir(cwd, home);

    expect(findSessionFile(dir, writer.id)).toBe(writer.file);
    expect(findSessionFile(dir, "20260101")).toBe(writer.file);
  });

  it("rejects ambiguous prefixes, missing ids, and path traversal", () => {
    const { home, cwd } = makeWorkspace();
    createSession({ cwd, model: "m", home, id: "abc-one" });
    createSession({ cwd, model: "m", home, id: "abc-two" });
    const dir = sessionsDir(cwd, home);

    expect(() => findSessionFile(dir, "abc")).toThrow(/ambiguous/);
    expect(() => findSessionFile(dir, "nope")).toThrow(/No session matching/);
    expect(() => findSessionFile(dir, "../abc")).toThrow(/Invalid session id/);
  });

  it("resumes a session created for the same workspace", () => {
    const { home, cwd } = makeWorkspace();
    const writer = createSession({ cwd, model: "m", home, id: "resume-me" });
    writer.appendMessage({ role: "user", content: "hello" });

    const loaded = resumeSession({ cwd, id: "resume-me", home });
    expect(loaded.header.id).toBe("resume-me");
    expect(loaded.messages).toEqual([{ role: "user", content: "hello" }]);
  });

  it("refuses a file whose header names another workspace", () => {
    const { home, cwd } = makeWorkspace();
    const other = tempDir("cooper-other-");
    const writer = createSession({ cwd, model: "m", home, id: "foreign" });

    const otherDir = sessionsDir(other, home);
    fs.mkdirSync(otherDir, { recursive: true });
    fs.copyFileSync(writer.file, path.join(otherDir, "foreign.jsonl"));

    expect(() => resumeSession({ cwd: other, id: "foreign", home })).toThrow(
      /belongs to/,
    );
  });
});

describe("policy records and runtime notices", () => {
  it("restores the last policy and persists runtime notices", () => {
    const { home, cwd } = makeWorkspace();
    const writer = createSession({ cwd, model: "m", home });

    writer.appendPolicy("plan");
    writer.appendMessage(permissionModeNotice("plan"));
    writer.appendPolicy("ask");
    writer.appendMessage({ role: "user", content: "hello" });

    const loaded = loadSession(writer.file);
    expect(loaded.preset).toBe("ask");
    expect(loaded.messages[0]).toEqual(permissionModeNotice("plan"));
    expect(loaded.messages[1]).toEqual({ role: "user", content: "hello" });
  });

  it("ignores malformed policy records", () => {
    const { home, cwd } = makeWorkspace();
    const writer = createSession({ cwd, model: "m", home });
    fs.appendFileSync(
      writer.file,
      `${JSON.stringify({ type: "policy", at: "x", preset: "yolo" })}\n`,
    );

    const loaded = loadSession(writer.file);
    expect(loaded.preset).toBeNull();
    expect(loaded.repaired).toBe(1);
  });

  it("does not use a runtime notice as the session preview", () => {
    const { home, cwd } = makeWorkspace();
    const writer = createSession({ cwd, model: "m", home, id: "preview" });
    writer.appendMessage(permissionModeNotice("plan"));
    writer.appendMessage({ role: "user", content: "real question" });

    const sessions = listSessions(sessionsDir(cwd, home));
    expect(sessions[0]?.preview).toBe("real question");
  });
});

describe("listSessions", () => {
  it("returns summaries with a preview, newest first", () => {
    const { home, cwd } = makeWorkspace();
    const first = createSession({ cwd, model: "m", home, id: "older" });
    first.appendMessage({ role: "user", content: "first question" });
    const second = createSession({ cwd, model: "m", home, id: "newer" });
    second.appendMessage({ role: "user", content: "second question" });

    // Make the order deterministic even on coarse filesystem timestamps.
    const old = new Date("2026-01-01T00:00:00Z");
    const recent = new Date("2026-02-01T00:00:00Z");
    fs.utimesSync(first.file, old, old);
    fs.utimesSync(second.file, recent, recent);

    const sessions = listSessions(sessionsDir(cwd, home));
    expect(sessions.map((session) => session.id)).toEqual(["newer", "older"]);
    expect(sessions[0]?.preview).toBe("second question");
    expect(sessions[0]?.model).toBe("m");
  });

  it("returns an empty list when the directory does not exist", () => {
    const { home, cwd } = makeWorkspace();
    expect(listSessions(sessionsDir(cwd, home))).toEqual([]);
  });

  it("skips files that are not valid sessions", () => {
    const { home, cwd } = makeWorkspace();
    const dir = sessionsDir(cwd, home);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "junk.jsonl"), "not json\n");

    expect(listSessions(dir)).toEqual([]);
  });
});

describe("SessionWriter.from", () => {
  it("reopens an existing session for appending", () => {
    const { home, cwd } = makeWorkspace();
    const writer = createSession({ cwd, model: "m", home, id: "continue" });
    writer.appendMessage({ role: "user", content: "one" });

    const resumed = loadSession(writer.file);
    const next = SessionWriter.from(resumed);
    next.appendMessage({ role: "assistant", content: "two" });

    expect(loadSession(writer.file).messages).toEqual([
      { role: "user", content: "one" },
      { role: "assistant", content: "two" },
    ]);
  });
});
