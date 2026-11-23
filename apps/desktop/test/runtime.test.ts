import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRunCommandTool, hasSessionLocks, SessionWriter, resumeSession, runCommandTool, sessionsDir, type AssistantMessage, type ChatRequest, type ProviderEvent, type ShellSandbox, type Tool } from "@cooper/core";
import { parseSettings, readSettingsDocument, resolveConfig } from "@cooper/host";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DraftStore } from "../src/drafts.js";
import { DesktopConnection } from "../src/connection.js";
import type { DesktopEvent } from "../src/ipc.js";
import { DesktopRuntime } from "../src/runtime.js";

let replies: (AssistantMessage | Error)[];
let reasoning: string[];
let requests: ChatRequest[];
let directory: string;
let root: string;
let home: string;
let target: string;
let runtime: DesktopRuntime;
let draftDirectory: string;
let approval: Promise<Extract<DesktopEvent, { type: "approval" }>>;
let events: DesktopEvent[];
let testTool: Tool | undefined;
const itWithLocks = it.skipIf(!hasSessionLocks());

vi.mock("@cooper/host", async (importOriginal) => {
  const host = await importOriginal<typeof import("@cooper/host")>();
  return {
    ...host,
    async prepareTools(...args: Parameters<typeof host.prepareTools>) {
      const prepared = await host.prepareTools(...args);
      if (testTool) {
        const builtin = prepared.tools.findIndex(({ name }) => name === testTool?.name);
        if (builtin === -1) prepared.tools.push(testTool);
        else prepared.tools[builtin] = testTool;
      }
      return prepared;
    },
    createProvider: () => ({
      async *stream(request: ChatRequest): AsyncIterable<ProviderEvent> {
        requests.push({ ...request, messages: request.messages.slice() });
        const message = replies.shift();
        if (!message) throw new Error("No response scripted");
        for (const delta of reasoning.splice(0)) yield { type: "reasoning", delta };
        if (message instanceof Error) throw message;
        if (message.content) yield { type: "text", delta: message.content };
        yield { type: "done", message, finishReason: null };
      },
    }),
  };
});

const read: AssistantMessage = {
  content: "", toolCalls: [{ id: "read", name: "read", arguments: '{"path":"target.txt"}' }],
};
const edit: AssistantMessage = {
  content: "", toolCalls: [{ id: "edit", name: "edit", arguments: '{"path":"target.txt","old_string":"old","new_string":"new"}' }],
};
const done: AssistantMessage = { content: "Finished.", toolCalls: [] };

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "cooper-desktop-test-"));
  root = path.join(directory, "project");
  home = path.join(directory, ".cooper");
  target = path.join(root, "target.txt");
  draftDirectory = path.join(directory, "drafts");
  await Promise.all([mkdir(root), mkdir(home)]);
  await Promise.all([
    writeFile(target, "old\r\n"),
    writeFile(path.join(home, "config.json"), JSON.stringify({
      protocol: "openai-chat", model: "test-model", baseURL: "http://127.0.0.1:1/v1", apiKey: "desktop-test-secret",
    })),
  ]);
  events = [];
  requests = [];
  replies = [];
  reasoning = [];
  testTool = undefined;
  approval = new Promise((resolve) => {
    runtime = new DesktopRuntime((event) => {
      events.push(event);
      if (event.type === "approval") resolve(event);
    }, new DraftStore(draftDirectory), home);
  });
  await runtime.openWorkspace(root);
});

afterEach(async () => {
  await runtime.dispose();
  await rm(directory, { recursive: true, force: true });
});

it("applies saved connection settings to the next message without replacing the conversation or draft", async () => {
  replies = [done, done];
  const previous = await runtime.send("First message");
  runtime.saveDraft(previous.draft.key, "Second message");
  const connection = new DesktopConnection(home);
  const status = connection.read();
  if (status.kind !== "ready") throw new Error("Expected valid configuration");
  const { config, document, values } = connection.prepare(status.revision, {
    ...status.fields, model: "new-model",
  });

  const state = runtime.saveConnection(config, document, values);
  expect(state).toMatchObject({ sessionId: previous.sessionId, model: "new-model", draft: { text: "Second message" } });
  expect(state?.messages).toEqual(previous.messages);
  await runtime.send("Second message");
  expect(requests.map(({ model }) => model)).toEqual(["test-model", "new-model"]);
});

it("uses default web search and applies an explicit opt-out to an open workspace", async () => {
  replies = [done, done];
  await runtime.send("First message");
  expect(requests[0]?.tools.map((tool) => tool.name)).toContain("web_search");

  const document = readSettingsDocument(home);
  const values = { ...document.raw, webSearch: false };
  const config = resolveConfig(parseSettings(values, document.file), { home });
  runtime.saveConnection(config, document, values);
  await runtime.send("Second message");
  expect(requests[1]?.tools.map((tool) => tool.name)).not.toContain("web_search");
});

it.each(hasSessionLocks() ? [1, 2] : [1])("restores the tool results in a v%i conversation", async (version) => {
  if (version === 1) {
    const session = SessionWriter.create({ cwd: root, home, model: "test-model", version: 1 });
    runtime.newChat(session.id);
  }
  replies = [read, edit, done];
  const sending = runtime.send("Update the file");
  const pending = await approval;
  expect(events[0]?.type).toBe("accepted");
  expect(pending.preview).toContain("-old");
  expect(pending.preview).toContain("+new");
  await expect(readFile(target, "utf8")).resolves.toBe("old\r\n");
  runtime.approve(pending.id, true);

  const state = await sending;
  await expect(readFile(target, "utf8")).resolves.toBe("new\r\n");
  expect(requests[1]?.messages).toContainEqual({ role: "tool", toolCallId: "read", content: "1 | old\n2 | " });
  expect(events).toContainEqual({ type: "text", delta: "Finished." });
  expect(JSON.stringify(events)).not.toContain("desktop-test-secret");
  expect(state.sessionId).toBeTruthy();
  expect(events.flatMap((event) => event.type === "tool-start" ? [event.callId] : [])).toEqual(["read", "edit"]);
  const toolRows = events.flatMap((event) => event.type === "tool"
    ? [{ role: "tool", summary: event.summary, text: event.content, isError: event.isError, durationMs: event.durationMs }] : []);
  expect(toolRows).toHaveLength(2);
  const transcript = [
    { role: "user", text: "Update the file" },
    ...toolRows,
    { role: "assistant", text: "Finished." },
  ];
  expect(state.messages).toEqual(transcript);

  await runtime.dispose();
  runtime = new DesktopRuntime(() => {}, new DraftStore(draftDirectory), home);
  const reopened = await runtime.openWorkspace(root);
  expect(reopened.sessions).toContainEqual({ id: state.sessionId, title: "Update the file" });
  expect(runtime.newChat(state.sessionId!).messages).toEqual(transcript);
  runtime.setMode("plan");
  expect(runtime.newChat(state.sessionId!).mode).toBe("plan");
});

it("restores a legacy tool result without display metadata", () => {
  const session = SessionWriter.create({ cwd: root, home, model: "test-model", version: 1 });
  expect(session.appendMessage({ role: "user", content: "Show the file" })).toBeNull();
  expect(session.appendMessage({ role: "assistant", ...read })).toBeNull();
  expect(session.appendMessage({ role: "tool", toolCallId: "read", content: "Legacy output", isError: true })).toBeNull();
  expect(runtime.newChat(session.id).messages).toEqual([
    { role: "user", text: "Show the file" },
    { role: "tool", summary: "read", text: "Legacy output", isError: true },
  ]);
});

it("shows the shell description with the command before approval", async () => {
  const input = {
    command: "echo ready > result.txt",
    description: "Write the readiness marker to result.txt.",
  };
  replies = [{ content: "", toolCalls: [{ id: "shell-call", name: "shell", arguments: JSON.stringify(input) }] }, done];
  const sending = runtime.send("Write a readiness marker");
  const pending = await approval;
  try {
    expect(pending.title).toBe("Run command");
    expect(pending.preview).toContain(`Purpose: ${input.description}`);
    expect(pending.preview).toContain(input.command);
  } finally {
    runtime.approve(pending.id, false);
    await sending;
  }
});

it("offers AUTO only with a sandbox and does not restore AUTO from a session", async () => {
  expect(runtime.getState()).toMatchObject({ mode: "ask", autoAvailable: false });
  expect(() => runtime.setMode("auto")).toThrow("Auto requires the Cooper shell sandbox");

  await runtime.dispose();
  testTool = createRunCommandTool({ kind: "powershell", executable: process.execPath });
  const sandbox = vi.fn<ShellSandbox>().mockResolvedValue({ kind: "exited", code: 0, stdout: "isolated output", stderr: "" });
  runtime = new DesktopRuntime((event) => events.push(event), new DraftStore(draftDirectory), home, undefined, sandbox);
  await expect(runtime.openWorkspace(root)).resolves.toMatchObject({ mode: "ask", autoAvailable: true });
  expect(runtime.setMode("auto").mode).toBe("auto");

  replies = [{ content: "", toolCalls: [{ id: "command", name: "shell",
    arguments: '{"command":"Write-Output \'hello\'","description":"Print a marker"}' }] }, done];
  const state = await runtime.send("Print a marker");
  const canonicalRoot = await realpath(root);
  expect(sandbox).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ root: canonicalRoot, cwd: canonicalRoot }),
    expect.any(AbortSignal));
  expect(events.some(({ type }) => type === "approval")).toBe(false);
  expect(requests[1]?.messages).toContainEqual(expect.objectContaining({
    role: "tool", toolCallId: "command", content: expect.stringContaining("isolated output"),
  }));
  expect(state.mode).toBe("auto");
  expect(runtime.newChat(state.sessionId!).mode).toBe("ask");
});

it("exposes a running approved tool until its matching result is written", async () => {
  let entered!: () => void;
  let finish!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const released = new Promise<void>((resolve) => { finish = resolve; });
  testTool = {
    name: "slow_task", description: "A controlled test tool", capabilities: ["execute"],
    inputSchema: runCommandTool.inputSchema, summarize: () => "Run slow task",
    async execute() {
      entered();
      await released;
      return { content: "Tool output" };
    },
  };
  await runtime.openWorkspace(root);
  replies = [{ content: "", toolCalls: [{
    id: "slow-call", name: testTool.name, arguments: '{"command":"test","description":"Run the controlled test task."}',
  }] }, done];
  const sending = runtime.send("Run the slow task");
  try {
    const pending = await approval;
    expect(runtime.getState()?.activeTool).toBeUndefined();
    runtime.approve(pending.id, true);
    await started;
    const start = events.find(({ type }) => type === "tool-start");
    expect(start).toMatchObject({ callId: "slow-call", summary: "Run slow task", startedAt: expect.any(Number) });
    expect(runtime.getState()).toMatchObject({ running: true, activeTool: {
      callId: "slow-call", summary: "Run slow task", startedAt: expect.any(Number),
    } });
    expect(events.some(({ type }) => type === "tool")).toBe(false);
  } finally {
    finish();
    await sending;
  }
  expect(events.find(({ type }) => type === "tool")).toMatchObject({
    callId: "slow-call", content: "Tool output", durationMs: expect.any(Number),
  });
  expect(runtime.getState()?.activeTool).toBeUndefined();
});

it("isolates drafts by session and workspace and flushes them on close", async () => {
  const fresh = runtime.newChat();
  const text = "  unsent\nnotes  \n";
  runtime.saveDraft(fresh.draft.key, text);
  replies = [done];
  const first = await runtime.send("First conversation");
  expect(runtime.newChat().draft.text).toBe("");
  runtime.saveDraft(fresh.draft.key, text);
  runtime.newChat(first.sessionId!);
  runtime.saveDraft(fresh.draft.key, "stale renderer event");
  runtime.saveDraft(first.draft.key, "First conversation draft");

  const otherRoot = path.join(directory, "other");
  await mkdir(otherRoot);
  const other = await runtime.openWorkspace(otherRoot);
  expect(other.draft.text).toBe("");
  runtime.saveDraft(other.draft.key, "Other workspace draft");
  await runtime.dispose();

  runtime = new DesktopRuntime(() => {}, new DraftStore(draftDirectory), home);
  expect((await runtime.openWorkspace(root)).draft.text).toBe(text);
  expect(runtime.newChat(first.sessionId!).draft.text).toBe("First conversation draft");
  expect((await runtime.openWorkspace(otherRoot)).draft.text).toBe("Other workspace draft");
});

it("retains the original draft when session creation fails before submission", async () => {
  const state = runtime.newChat();
  const dir = sessionsDir(root, home);
  await mkdir(path.dirname(dir), { recursive: true });
  await writeFile(dir, "Blocks session directory creation");
  const text = "  keep this\n exactly  ";
  await expect(runtime.send(text)).rejects.toThrow();
  expect(new DraftStore(draftDirectory).read(state.draft.key)).toMatchObject({ text, pending: false });
  expect(events.filter(({ type }) => type !== "run-settled")).toEqual([]);
  expect(requests).toEqual([]);
});

it("acknowledges the persisted user message even when the provider fails", async () => {
  const draft = runtime.newChat().draft;
  await expect(runtime.send("  adopted once  ")).rejects.toThrow("No response scripted");
  const accepted = events.find((event) => event.type === "accepted");
  expect(accepted?.message).toEqual({ role: "user", text: "adopted once" });
  expect(accepted?.draft).toMatchObject({ text: "", pending: false });
  expect(new DraftStore(draftDirectory).read(draft.key)).toEqual({ text: "", pending: false });
  expect(runtime.newChat(accepted!.sessionId).messages).toEqual([{ role: "user", text: "adopted once" }]);
});

it("streams display reasoning to the renderer without storing it in the session", async () => {
  reasoning = ["Inspect the environment.", " Check the tool versions."];
  replies = [done];
  const state = await runtime.send("Check the installation");
  expect(state.expandReasoning).toBe(false);
  expect(events.filter((event) => event.type === "reasoning")).toEqual([
    { type: "reasoning", delta: "Inspect the environment." },
    { type: "reasoning", delta: " Check the tool versions." },
  ]);
  const saved = resumeSession({ cwd: root, home, id: state.sessionId! });
  expect(await readFile(saved.file, "utf8")).not.toMatch(/Inspect the environment|Check the tool versions/);
  expect(runtime.newChat(state.sessionId!).messages.map(({ text }) => text)).toEqual([
    "Check the installation", "Finished.",
  ]);
});

it("preserves an unconfirmed v1 submission after reopening and waits for explicit editing", async () => {
  await runtime.dispose();
  runtime = new DesktopRuntime((event) => events.push(event), new DraftStore(draftDirectory), home, false);
  await runtime.openWorkspace(root);
  const draft = runtime.newChat().draft;
  const appendMessage = SessionWriter.prototype.appendMessage;
  const append = vi.spyOn(SessionWriter.prototype, "appendMessage").mockImplementation(function (this: SessionWriter, message, ...rest) {
    const error = appendMessage.call(this, message, ...rest);
    return error ?? (message.role === "user" && !message.runtime ? new Error("Append result lost") : null);
  });
  const text = "  check before resending \n";
  try {
    await expect(runtime.send(text)).rejects.toThrow("Append result lost");
  } finally {
    append.mockRestore();
  }
  expect(events).toContainEqual({ type: "draft-pending", key: draft.key });
  await runtime.dispose();

  runtime = new DesktopRuntime(() => {}, new DraftStore(draftDirectory), home);
  const reopened = await runtime.openWorkspace(root);
  expect(reopened.draft).toEqual({ key: draft.key, text, pending: true });
  expect(reopened.sessions).toHaveLength(1);
  runtime.saveDraft(draft.key, "late autosave");
  await expect(runtime.send(text)).rejects.toThrow("Check the pending draft");
  expect(requests).toEqual([]);
  expect(runtime.keepEditingDraft(draft.key).draft).toEqual({ key: draft.key, text, pending: false });
  expect(runtime.newChat(reopened.sessions[0]!.id).messages).toEqual([{ role: "user", text: text.trim() }]);
});

it.each(["deny", "stop"])("keeps the file intact when the approval is closed with %s", async (action) => {
  replies = [edit, done];
  const sending = runtime.send("Update the file");
  const pending = await approval;
  if (action === "stop") runtime.stop();
  else runtime.approve(pending.id, false);
  const result = await sending;

  await expect(readFile(target, "utf8")).resolves.toBe("old\r\n");
  expect(events).toContainEqual({ type: "approval-closed", id: pending.id });
  expect(events.some(({ type }) => type === "tool-start")).toBe(false);
  expect(() => runtime.approve(pending.id, true)).toThrow("no longer active");
  const saved = resumeSession({ cwd: root, home, id: result.sessionId! });
  if (saved.header.version === 1) return;
  if (action === "stop") {
    expect(saved.runs[0]).toMatchObject({ stopRequested: "user-stop", end: { status: "stopped", phase: "approval" } });
    expect([...saved.toolUi.values()][0]?.recovery).toBe("not-started");
  } else {
    expect(saved.runs[0]?.end?.status).toBe("completed");
    expect([...saved.toolUi.values()][0]).toMatchObject({ denied: true });
  }
});

itWithLocks("reattaches to a live approval and keeps a second runtime from recovering it", async () => {
  replies = [edit];
  const sending = runtime.send("Update the file");
  const pending = await approval;
  const attached = runtime.getState()!;
  expect(attached).toMatchObject({ running: true, approval: pending, run: { status: "running" } });
  expect(attached.messages.map(({ role }) => role)).toEqual(["user"]);
  const other = new DesktopRuntime(() => {}, new DraftStore(draftDirectory), home);
  try {
    await other.openWorkspace(root);
    const viewing = other.newChat(attached.sessionId!);
    expect(viewing.run).toMatchObject({ status: "in-use", continuable: false });
    await expect(other.send("Cannot run concurrently")).rejects.toThrow("in use");
  } finally {
    await other.dispose();
    runtime.stop(attached.run?.runId);
    await sending;
  }
});

itWithLocks("reconciles an acknowledged-on-disk v2 submission after the original reply is lost", async () => {
  const draft = runtime.newChat().draft;
  const appendMessage = SessionWriter.prototype.appendMessage;
  const append = vi.spyOn(SessionWriter.prototype, "appendMessage").mockImplementation(function (this: SessionWriter, message, ...rest) {
    const error = appendMessage.call(this, message, ...rest);
    return error ?? (rest[2]?.kind === "submission" ? new Error("Lost receipt") : null);
  });
  try {
    await expect(runtime.send("Save exactly once")).rejects.toThrow("Lost receipt");
  } finally {
    append.mockRestore();
  }
  expect(new DraftStore(draftDirectory).read(draft.key).pending).toBe(true);
  await runtime.dispose();
  runtime = new DesktopRuntime(() => {}, new DraftStore(draftDirectory), home);
  const reopened = await runtime.openWorkspace(root);
  expect(reopened.draft).toMatchObject({ text: "", pending: false });
  expect(reopened.sessionId).toBe(reopened.sessions[0]!.id);
  const state = runtime.newChat(reopened.sessions[0]!.id);
  expect(state.run).toMatchObject({ status: "pending", continuable: true });
  expect(state.messages).toEqual([{ role: "user", text: "Save exactly once" }]);
  expect(requests).toEqual([]);
  replies = [done];
  const continued = await runtime.continueTurn(state.run!.turnId);
  expect(continued.run?.status).toBe("completed");
  expect(continued.messages.filter(({ role }) => role === "user")).toEqual(state.messages);
});

itWithLocks("requires a read-only review and separate confirmation after an uncertain edit", async () => {
  const writer = SessionWriter.create({ cwd: root, home, model: "test-model", version: 2 });
  try {
    expect(writer.appendMessage({ role: "user", content: "Update" }, undefined, undefined,
      { kind: "submission", requestId: "request", turnId: "turn" })).toBeNull();
    writer.startRun("turn");
    expect(writer.recordEvent({ type: "assistant-done", ...edit }, [])).toBeNull();
    writer.beforeTool(edit.toolCalls![0]!, true);
  } finally {
    writer.close();
  }
  expect(runtime.newChat(writer.id).run).toMatchObject({ status: "interrupted", needsReview: true });
  await expect(runtime.send("Bypass the review")).rejects.toThrow("review");
  replies = [edit, done];
  const checked = await runtime.continueTurn("turn", true);
  expect(checked.run).toMatchObject({ status: "completed", reviewed: true, needsReview: true });
  expect(events.some(({ type }) => type === "approval")).toBe(false);
  await expect(readFile(target, "utf8")).resolves.toBe("old\r\n");
  await expect(runtime.continueTurn("turn")).rejects.toThrow("Confirm");
  replies = [edit, done];
  const continuing = runtime.continueTurn("turn", true);
  const pending = await approval;
  runtime.approve(pending.id, true);
  expect((await continuing).run).toMatchObject({ status: "completed", needsReview: false });
  await expect(readFile(target, "utf8")).resolves.toBe("new\r\n");
  await expect(runtime.send("An independent turn")).rejects.toThrow("No response scripted");
  expect(runtime.getState()?.run).toMatchObject({ status: "failed", needsReview: false });
});

itWithLocks("retries a disconnected follow-up request without dispatching the prior tool again", async () => {
  replies = [read, Object.assign(new Error("disconnected"), { code: "ECONNRESET" }), done];
  const state = await runtime.send("Check the file");
  expect(state.run?.status).toBe("completed");
  expect(requests).toHaveLength(3);
  expect(requests[1]?.messages).toEqual(requests[2]?.messages);
  expect(events.filter(({ type }) => type === "tool")).toHaveLength(1);
  expect(events).toContainEqual({ type: "retry", attempt: 2, maxAttempts: 3, delayMs: 1000 });
});

itWithLocks("reports disconnection after display reasoning without replaying the request", async () => {
  reasoning = ["Inspecting…"];
  replies = [Object.assign(new Error("disconnected"), { code: "ECONNRESET" }), done];
  await expect(runtime.send("Check the file")).rejects.toThrow("disconnected");
  expect(requests).toHaveLength(1);
  expect(runtime.getState()?.run).toMatchObject({ status: "failed", reason: "provider-error" });
});

itWithLocks("cancels pending model backoff when the user stops", async () => {
  await runtime.dispose();
  let waiting!: () => void;
  const retrying = new Promise<void>((resolve) => { waiting = resolve; });
  runtime = new DesktopRuntime((event) => { if (event.type === "retry") waiting(); }, new DraftStore(draftDirectory), home);
  await runtime.openWorkspace(root);
  replies = [Object.assign(new Error("overloaded"), { status: 503, headers: new Headers({ "retry-after": "5" }) }), done];
  const pending = runtime.send("Check the file");
  await retrying;
  runtime.stop();
  const state = await pending;
  expect(requests).toHaveLength(1);
  expect(state.run).toMatchObject({ status: "stopped", reason: "user-stop" });
});

itWithLocks("stops after an approved edit when its result cannot be written", async () => {
  replies = [edit, done];
  const recordEvent = SessionWriter.prototype.recordEvent;
  const record = vi.spyOn(SessionWriter.prototype, "recordEvent").mockImplementation(function (this: SessionWriter, event, ...rest) {
    return event.type === "tool-end" ? new Error("Could not save tool result") : recordEvent.call(this, event, ...rest);
  });
  try {
    const sending = runtime.send("Update the file");
    runtime.approve((await approval).id, true);
    await expect(sending).rejects.toThrow("Could not save tool result");
    expect(requests).toHaveLength(1);
    await expect(readFile(target, "utf8")).resolves.toBe("new\r\n");
    expect(runtime.getState()).toMatchObject({ run: { status: "failed", reason: "storage-error", needsReview: true } });
    expect(events).toContainEqual({ type: "tool-interrupted", callId: "edit" });
    expect(runtime.getState()?.activeTool).toBeUndefined();
  } finally {
    record.mockRestore();
  }
});
