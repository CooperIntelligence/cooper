import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { hasSessionLocks, loadSession, SessionBusyError, SessionWriter, sessionWriterBusy, type ToolCall } from "../src/index.js";

let home: string;
let writer: SessionWriter | undefined;
const itWithLocks = it.skipIf(!hasSessionLocks());

beforeEach(() => { home = mkdtempSync(join(tmpdir(), "cooper-v2-")); });
afterEach(() => {
  writer?.close();
  writer = undefined;
  rmSync(home, { recursive: true, force: true });
});

function start() {
  writer = SessionWriter.create({ cwd: home, home, model: "test", version: 2 });
  expect(writer.appendMessage({ role: "user", content: "Update the project" }, undefined, undefined,
    { kind: "submission", requestId: "request", turnId: "turn" })).toBeNull();
  writer.startRun("turn");
  return writer;
}

const calls: ToolCall[] = ["edit", "shell", "read"].map((name) => ({ id: name, name, arguments: "{}" }));

itWithLocks("preserves real results and recovers missing results only after obtaining write access", () => {
  const session = start();
  expect(session.recordEvent({ type: "assistant-done", content: "", toolCalls: calls }, [])).toBeNull();
  session.beforeTool(calls[0]!, true);
  expect(session.recordEvent({ type: "tool-end", call: calls[0]!, summary: "Edit done", result: { content: "Updated" },
    durationMs: 1, denied: false, isError: false }, [])).toBeNull();
  session.beforeTool(calls[1]!, true);
  expect(session.stopRequested("user-stop")).toBeNull();
  session.close();

  const bytes = readFileSync(session.file);
  const saved = loadSession(session.file);
  expect(readFileSync(session.file)).toEqual(bytes);
  expect(saved.submissions.get("request")).toMatchObject({ turnId: "turn", text: "Update the project" });
  expect(saved.runs[0]).toMatchObject({ stopRequested: "user-stop" });
  expect(saved.runs[0]?.end).toBeUndefined();
  expect(saved.messages.flatMap((message) => message.role === "tool" ? [message.toolCallId] : [])).toEqual(["edit", "shell", "read"]);
  expect([...saved.toolUi.values()].map(({ summary, recovery }) => recovery ?? summary)).toEqual(["Edit done", "outcome-unknown", "unconfirmed"]);
  expect(saved.needsReview).toBe(true);

  writer = SessionWriter.from(saved, { writeV2: true });
  expect(writer.recover(saved)).toBeNull();
  const recovered = loadSession(session.file);
  expect(recovered.runs[0]?.end).toMatchObject({ status: "interrupted", reason: "unknown", source: "recovered" });
  expect(recovered.messages).toEqual(saved.messages);
  const recoveredBytes = readFileSync(session.file);
  expect(writer.recover(recovered)).toBeNull();
  expect(readFileSync(session.file)).toEqual(recoveredBytes);
});

itWithLocks("distinguishes a confirmed stop before dispatch from an abrupt exit", () => {
  const session = start();
  expect(session.recordEvent({ type: "assistant-done", content: "", toolCalls: [calls[0]!] }, [])).toBeNull();
  expect(session.stopRequested("host-shutdown")).toBeNull();
  expect(session.endRun("stopped", "host-shutdown", "approval")).toBeNull();
  const saved = loadSession(session.file);
  expect(saved.runs[0]?.end).toMatchObject({ status: "stopped", reason: "host-shutdown", phase: "approval" });
  expect([...saved.toolUi.values()][0]?.recovery).toBe("not-started");
  expect(saved.needsReview).toBe(false);
});

itWithLocks("commits a final answer and completion in the same record", () => {
  const session = start();
  expect(session.recordEvent({ type: "assistant-done", content: "Finished", toolCalls: [] }, [])).toBeNull();
  expect(session.stopRequested("user-stop")).toBeNull();
  const saved = loadSession(session.file);
  expect(saved.messages.at(-1)).toEqual({ role: "assistant", content: "Finished" });
  expect(saved.runs[0]?.end).toMatchObject({ status: "completed", reason: "completed", source: "observed" });
  expect(saved.runs[0]?.stopRequested).toBeUndefined();
});

itWithLocks("keeps a committed final answer when the append outcome was reported as an error", () => {
  const session = start();
  const prev = loadSession(session.file).runs[0]!;
  appendFileSync(session.file, JSON.stringify({ type: "message", at: new Date().toISOString(),
    message: { role: "assistant", content: "Finished" },
    meta: { kind: "assistant", assistantId: "answer", runId: prev.runId, turnId: prev.turnId, final: true } }) + "\n");
  expect(session.endRun("failed", "storage-error", "storage")).toBeNull();
  const saved = loadSession(session.file);
  expect(saved.damaged).toBe(false);
  expect(saved.runs[0]?.end?.status).toBe("completed");
});

itWithLocks("excludes a separate writer and releases the lock after the holder is killed", async () => {
  const session = start();
  session.close();
  const child = spawn(process.execPath, [...process.execArgv.filter((arg) => arg === "--experimental-sqlite"),
    "-e", `const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(process.argv[1]);
      db.exec('BEGIN EXCLUSIVE');
      process.stdout.write('locked');
      setInterval(() => {}, 1000);`, `${session.file}.lock.sqlite`], { stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(child, "close");
  try {
    expect(await Promise.race([
      once(child.stdout, "data").then(([data]) => String(data)),
      exited.then(() => "child exited before locking"),
    ])).toBe("locked");
    const bytes = readFileSync(session.file);
    expect(sessionWriterBusy(session.file)).toBe(true);
    expect(() => SessionWriter.from(loadSession(session.file), { writeV2: true })).toThrow(SessionBusyError);
    expect(readFileSync(session.file)).toEqual(bytes);
  } finally {
    child.kill();
    await exited;
  }
  expect(sessionWriterBusy(session.file)).toBe(false);
  writer = SessionWriter.from(loadSession(session.file), { writeV2: true });
});
