import { describe, expect, it } from "vitest";
import type { Message } from "../src/types.js";
import { estimateMessageTokens } from "../src/context/estimator.js";
import {
  findCompactionCut,
  groupMessages,
  leadingSystemCount,
  toolCallIndex,
} from "../src/context/groups.js";

function conversation(): Message[] {
  return [
    { role: "system", content: "system prompt" },
    { role: "user", content: "first request" },
    {
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "a", name: "read_file", arguments: '{"path":"a.ts"}' },
        { id: "b", name: "read_file", arguments: '{"path":"b.ts"}' },
      ],
    },
    { role: "tool", toolCallId: "a", content: "contents of a" },
    { role: "tool", toolCallId: "b", content: "contents of b" },
    { role: "assistant", content: "done reading" },
    { role: "user", content: "second request" },
    { role: "assistant", content: "second answer" },
  ];
}

describe("groupMessages", () => {
  it("keeps an assistant message with its tool results", () => {
    const groups = groupMessages(conversation());
    expect(groups.map((group) => group.messages.length)).toEqual([
      1, 1, 3, 1, 1, 1,
    ]);
    expect(groups[2]?.start).toBe(2);
    expect(groups[2]?.end).toBe(5);
  });

  it("does not absorb an unrelated tool message", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "a", name: "read_file", arguments: "{}" }],
      },
      { role: "tool", toolCallId: "other", content: "orphan" },
    ];
    const groups = groupMessages(messages);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.messages).toHaveLength(1);
  });
});

describe("toolCallIndex", () => {
  it("maps ids to their calls", () => {
    const calls = toolCallIndex(conversation());
    expect(calls.get("b")?.name).toBe("read_file");
  });
});

describe("leadingSystemCount", () => {
  it("counts only the leading system block", () => {
    expect(leadingSystemCount(conversation())).toBe(1);
    expect(
      leadingSystemCount([
        { role: "system", content: "a" },
        { role: "system", content: "b" },
        { role: "user", content: "c" },
      ]),
    ).toBe(2);
    expect(leadingSystemCount([])).toBe(0);
  });
});

describe("findCompactionCut", () => {
  it("always returns a group boundary above the system block", () => {
    const messages = conversation();
    const starts = new Set(groupMessages(messages).map((group) => group.start));

    for (const keep of [0, 1, 10, 50, 200, 10_000]) {
      const cut = findCompactionCut(messages, keep, estimateMessageTokens);
      expect(cut).toBeGreaterThanOrEqual(1);
      expect(starts.has(cut)).toBe(true);
      expect(cut).toBeLessThan(messages.length);
    }
  });

  it("keeps the newest group even when it alone exceeds the budget", () => {
    const messages = conversation();
    const cut = findCompactionCut(messages, 0, estimateMessageTokens);
    expect(cut).toBe(7);
  });

  it("returns the system boundary when everything must be kept", () => {
    const messages = conversation();
    const cut = findCompactionCut(messages, 100_000, estimateMessageTokens);
    expect(cut).toBe(1);
  });
});
