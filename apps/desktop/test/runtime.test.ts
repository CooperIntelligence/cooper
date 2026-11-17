import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AssistantMessage, ChatRequest, ProviderEvent } from "@cooper/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DesktopEvent } from "../src/ipc.js";
import { DesktopRuntime } from "../src/runtime.js";

let replies: AssistantMessage[];
let requests: ChatRequest[];
let directory: string;
let root: string;
let home: string;
let target: string;
let runtime: DesktopRuntime;
let approval: Promise<Extract<DesktopEvent, { type: "approval" }>>;
let events: DesktopEvent[];

vi.mock("@cooper/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@cooper/host")>()),
  createProvider: () => ({
    async *stream(request: ChatRequest): AsyncIterable<ProviderEvent> {
      requests.push({ ...request, messages: request.messages.slice() });
      const message = replies.shift();
      if (!message) throw new Error("No response scripted");
      if (message.content) yield { type: "text", delta: message.content };
      yield { type: "done", message, finishReason: null };
    },
  }),
}));

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
  approval = new Promise((resolve) => {
    runtime = new DesktopRuntime((event) => {
      events.push(event);
      if (event.type === "approval") resolve(event);
    }, home);
  });
  await runtime.openWorkspace(root);
});

afterEach(async () => {
  await runtime.dispose();
  await rm(directory, { recursive: true, force: true });
});

it("streams a workspace read, applies an approved edit and resumes the conversation", async () => {
  replies = [read, edit, done];
  const sending = runtime.send("Update the file");
  const pending = await approval;
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

  await runtime.dispose();
  runtime = new DesktopRuntime(() => {}, home);
  const reopened = await runtime.openWorkspace(root);
  expect(reopened.sessions).toContainEqual({ id: state.sessionId, title: "Update the file" });
  expect(runtime.newChat(state.sessionId!).messages).toEqual([
    { role: "user", text: "Update the file" },
    { role: "assistant", text: "Finished." },
  ]);
  runtime.setMode("plan");
  expect(runtime.newChat(state.sessionId!).mode).toBe("plan");
});

it.each(["deny", "stop"])("keeps the file intact when the approval is closed with %s", async (action) => {
  replies = [edit, done];
  const sending = runtime.send("Update the file");
  const pending = await approval;
  if (action === "stop") runtime.stop();
  else runtime.approve(pending.id, false);
  await sending;

  await expect(readFile(target, "utf8")).resolves.toBe("old\r\n");
  expect(events).toContainEqual({ type: "approval-closed", id: pending.id });
  expect(() => runtime.approve(pending.id, true)).toThrow("no longer active");
});
