import { describe, expect, it } from "vitest";
import {
  permissionModeNotice,
  type LoadedSession,
  type Message,
} from "@cooper/core";
import { buildResumeView } from "../src/session-view.js";

function session(
  messages: Message[],
  toolUi: LoadedSession["toolUi"] = new Map(),
): LoadedSession {
  return {
    header: {
      type: "session",
      version: 1,
      id: "s",
      cwd: "/workspace",
      model: "m",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    file: "/workspace/s.jsonl",
    messages,
    toolUi,
    preset: null,
    repaired: 0,
  };
}

describe("buildResumeView", () => {
  it("hides host runtime notices from the user transcript", () => {
    const view = buildResumeView(
      session([
        permissionModeNotice("plan"),
        { role: "user", content: "hello" },
      ]),
      1,
    );

    expect(view.items).toEqual([{ id: 1, kind: "user", text: "hello" }]);
    expect(view.nextId).toBe(2);
  });

  it("splits assistant text into lines with one header", () => {
    const view = buildResumeView(
      session([
        { role: "user", content: "hello" },
        { role: "assistant", content: "one\ntwo" },
      ]),
      5,
    );

    expect(view.items).toEqual([
      { id: 5, kind: "user", text: "hello" },
      {
        id: 6, kind: "assistant-line", first: true,
        line: { kind: "text", spans: [{ text: "one" }] },
      },
      {
        id: 7, kind: "assistant-line", first: false,
        line: { kind: "text", spans: [{ text: "two" }] },
      },
    ]);
    expect(view.nextId).toBe(8);
  });

  it("formats restored code without carrying an unclosed fence into the next reply", () => {
    const view = buildResumeView(
      session([
        { role: "assistant", content: "```ts\n  const x = 1" },
        { role: "assistant", content: "# Summary" },
      ]),
      1,
    );

    expect(view.items).toMatchObject([
      { first: true, line: { kind: "code-label", text: "ts" } },
      { first: false, line: { kind: "code", text: "  const x = 1" } },
      { first: true, line: { kind: "heading", spans: [{ text: "Summary" }] } },
    ]);
  });

  it("restores tool rows from recorded display metadata", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "read_file", arguments: "{}" }],
      },
      { role: "tool", toolCallId: "c1", content: "contents" },
    ];
    const toolUi = new Map([
      [
        1,
        {
          toolName: "read_file",
          summary: "read a.ts",
          isError: false,
          denied: false,
          durationMs: 3,
        },
      ],
    ]);

    const view = buildResumeView(session(messages, toolUi), 1);
    expect(view.items).toEqual([
      {
        id: 1,
        kind: "tool",
        name: "read_file",
        summary: "read a.ts",
        status: "ok",
        output: "contents",
        durationMs: 3,
      },
    ]);
  });

  it("falls back to the assistant call when no UI metadata survived", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "c1", name: "grep", arguments: JSON.stringify({ pattern: "x" }) },
        ],
      },
      { role: "tool", toolCallId: "c1", content: "hit" },
    ];

    const view = buildResumeView(session(messages), 1);
    const item = view.items[0];
    expect(item).toMatchObject({
      kind: "tool",
      name: "grep",
      summary: `grep {"pattern":"x"}`,
      status: "ok",
    });
  });

  it("renders compaction stubs as notices, not user input", () => {
    const view = buildResumeView(
      session([
        {
          role: "user",
          content: "[Earlier conversation summary]\nline one\nline two",
        },
      ]),
      1,
    );

    const item = view.items[0];
    expect(item).toMatchObject({ kind: "notice", tone: "info" });
    expect(item?.kind === "notice" ? item.text : "").toContain(
      "Earlier conversation summary",
    );
  });
});
