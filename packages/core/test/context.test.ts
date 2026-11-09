import { describe, expect, it } from "vitest";
import type { Message } from "../src/types.js";
import type {
  ChatRequest,
  Provider,
  ProviderEvent,
} from "../src/provider/types.js";
import { estimateConversationTokens } from "../src/context/estimator.js";
import {
  isRuntimeNotice,
  permissionModeNotice,
} from "../src/runtime-notice.js";
import {
  prepareContext,
  resolveContextConfig,
} from "../src/context/budget.js";
import { pruneToolOutputs } from "../src/context/prune.js";
import { chunkMessages } from "../src/context/summarize.js";

class ScriptedProvider implements Provider {
  readonly requests: ChatRequest[] = [];

  constructor(private readonly text: string) {}

  async *stream(request: ChatRequest): AsyncIterable<ProviderEvent> {
    this.requests.push(request);
    yield { type: "text", delta: this.text };
    yield {
      type: "done",
      message: { content: this.text, toolCalls: [] },
      finishReason: "stop",
    };
  }
}

class FailingProvider implements Provider {
  async *stream(): AsyncIterable<ProviderEvent> {
    throw new Error("summarizer unavailable");
  }
}

const SYSTEM: Message = { role: "system", content: "You are a test agent." };

function cycle(index: number, chars: number): Message[] {
  return [
    {
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: `call_${index}`,
          name: "read_file",
          arguments: JSON.stringify({ path: `src/file${index}.ts` }),
        },
      ],
    },
    {
      role: "tool",
      toolCallId: `call_${index}`,
      content: `result ${index} ${"x".repeat(chars)}`,
    },
  ];
}

function toolHistory(count: number, chars: number): Message[] {
  const messages: Message[] = [SYSTEM, { role: "user", content: "start" }];
  for (let index = 0; index < count; index += 1) {
    messages.push(...cycle(index, chars));
  }
  messages.push({ role: "assistant", content: "still working" });
  return messages;
}

function chatHistory(pairs: number, chars: number): Message[] {
  const messages: Message[] = [
    SYSTEM,
    { role: "user", content: "original goal" },
  ];
  for (let index = 0; index < pairs; index += 1) {
    messages.push({ role: "user", content: "u".repeat(chars) });
    messages.push({ role: "assistant", content: "a".repeat(chars) });
  }
  return messages;
}

function orphanToolMessages(messages: Message[]): number {
  const known = new Set<string>();
  let orphans = 0;
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const call of message.toolCalls ?? []) known.add(call.id);
    } else if (message.role === "tool" && !known.has(message.toolCallId)) {
      orphans += 1;
    }
  }
  return orphans;
}

describe("pruneToolOutputs", () => {
  it("stubs old results and keeps the recent ones verbatim", () => {
    const messages = toolHistory(12, 4000);
    const stats = pruneToolOutputs(messages, { keepRecent: 8 });

    expect(stats.pruned).toBe(4);
    expect(stats.reclaimedTokens).toBeGreaterThan(0);

    const results = messages.filter((message) => message.role === "tool");
    expect(results).toHaveLength(12);
    for (const message of results.slice(0, 4)) {
      expect(message.content).toContain("elided");
      expect(message.content).toContain("read_file");
    }
    for (const message of results.slice(4)) {
      expect(message.content.startsWith("result")).toBe(true);
    }
  });

  it("skips results too small to matter", () => {
    const messages = toolHistory(12, 100);
    expect(pruneToolOutputs(messages, { keepRecent: 8 }).pruned).toBe(0);
  });
});

describe("chunkMessages", () => {
  it("splits on group boundaries without separating tool calls", () => {
    const messages = toolHistory(6, 2000);
    const chunks = chunkMessages(messages, 2000);
    expect(chunks.length).toBeGreaterThan(1);

    for (const chunk of chunks) {
      const calls = new Set<string>();
      let results = 0;
      for (const message of chunk) {
        if (message.role === "assistant") {
          for (const call of message.toolCalls ?? []) calls.add(call.id);
        } else if (message.role === "tool") {
          expect(calls.has(message.toolCallId)).toBe(true);
          results += 1;
        }
      }
      expect(results).toBe(calls.size);
    }
  });
});

describe("prepareContext", () => {
  it("does nothing while the conversation fits", async () => {
    const messages = chatHistory(2, 200);
    const provider = new ScriptedProvider("unused");
    const actions = await prepareContext({
      messages,
      tools: [],
      provider,
      model: "test",
      config: resolveContextConfig({ window: 200_000 }),
    });

    expect(actions).toEqual([]);
    expect(provider.requests).toHaveLength(0);
  });

  it("prunes before it spends a summarization call", async () => {
    const messages = toolHistory(12, 4000);
    const provider = new ScriptedProvider("unused");
    const before = estimateConversationTokens(messages);

    const actions = await prepareContext({
      messages,
      tools: [],
      provider,
      model: "test",
      config: resolveContextConfig({ window: 20_000, reserveOutputTokens: 0 }),
    });

    expect(actions.map((action) => action.action)).toEqual(["prune"]);
    expect(provider.requests).toHaveLength(0);
    expect(estimateConversationTokens(messages)).toBeLessThan(before);
  });

  it("summarizes the prefix and keeps the recent tail", async () => {
    const messages = chatHistory(40, 2000);
    const provider = new ScriptedProvider("Summary: the goal was X.");
    const before = estimateConversationTokens(messages);
    const originalLength = messages.length;

    const actions = await prepareContext({
      messages,
      tools: [],
      provider,
      model: "test",
      config: resolveContextConfig({ window: 30_000, reserveOutputTokens: 0 }),
    });

    expect(actions.map((action) => action.action)).toEqual(["summarize"]);
    // Long prefixes are summarized in chunks, so one summarize action can mean
    // several provider calls.
    expect(provider.requests.length).toBeGreaterThan(0);
    for (const request of provider.requests) {
      expect(request.tools).toEqual([]);
    }

    expect(messages[0]?.role).toBe("system");
    const replacement = messages[1];
    expect(replacement?.role).toBe("user");
    expect(replacement?.content).toContain("Earlier conversation summary");
    expect(replacement?.content).toContain("Summary: the goal was X.");

    expect(messages.length).toBeLessThan(originalLength);
    expect(estimateConversationTokens(messages)).toBeLessThan(before);
  });

  it("keeps the latest runtime notice after compaction", async () => {
    const notice = permissionModeNotice("plan");
    const messages = chatHistory(40, 2000);
    messages.splice(1, 0, notice);

    const actions = await prepareContext({
      messages,
      tools: [],
      provider: new ScriptedProvider("Summary: the goal was X."),
      model: "test",
      config: resolveContextConfig({ window: 30_000, reserveOutputTokens: 0 }),
    });

    expect(actions.length).toBeGreaterThan(0);
    expect(messages.filter(isRuntimeNotice)).toEqual([notice]);
    expect(messages.at(-1)).toBe(notice);
  });

  it("falls back to truncation when summarization fails", async () => {
    const messages = chatHistory(40, 2000);
    const before = estimateConversationTokens(messages);

    const actions = await prepareContext({
      messages,
      tools: [],
      provider: new FailingProvider(),
      model: "test",
      config: resolveContextConfig({ window: 30_000, reserveOutputTokens: 0 }),
    });

    expect(actions.map((action) => action.action)).toEqual(["truncate"]);
    expect(messages[0]?.role).toBe("system");
    expect(messages[1]?.content).toContain("were dropped");
    expect(estimateConversationTokens(messages)).toBeLessThan(before);
  });

  it("drops whole groups, never half a tool exchange", async () => {
    const messages = toolHistory(3, 40_000);

    const actions = await prepareContext({
      messages,
      tools: [],
      provider: new FailingProvider(),
      model: "test",
      config: resolveContextConfig({
        window: 30_000,
        reserveOutputTokens: 0,
        keepRecentToolResults: 8,
      }),
    });

    expect(actions.some((action) => action.action === "truncate")).toBe(true);
    expect(orphanToolMessages(messages)).toBe(0);
    expect(messages[0]?.role).toBe("system");
  });

  it("leaves the transcript alone when compaction cannot pay for itself", async () => {
    const messages: Message[] = [
      SYSTEM,
      { role: "user", content: "read this" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c", name: "read_file", arguments: "{}" }],
      },
      { role: "tool", toolCallId: "c", content: "x".repeat(20_000) },
    ];
    const before = estimateConversationTokens(messages);
    const provider = new ScriptedProvider("summary");

    const actions = await prepareContext({
      messages,
      tools: [],
      provider,
      model: "test",
      config: resolveContextConfig({ window: 6000, reserveOutputTokens: 0 }),
    });

    // A lone tool result dominates the window: summarizing the tiny prefix
    // would cost more than it saves, and dropping the request would not help.
    expect(actions).toEqual([]);
    expect(provider.requests).toHaveLength(0);
    expect(estimateConversationTokens(messages)).toBe(before);
  });

  it("can be disabled entirely", async () => {
    const messages = chatHistory(40, 2000);
    const actions = await prepareContext({
      messages,
      tools: [],
      provider: new ScriptedProvider("unused"),
      model: "test",
      config: resolveContextConfig({
        window: 30_000,
        reserveOutputTokens: 0,
        enabled: false,
      }),
    });

    expect(actions).toEqual([]);
    expect(messages).toHaveLength(82);
  });
});
