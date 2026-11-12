import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { runAgent } from "../src/agent.js";
import { PermissionPolicy } from "../src/permissions.js";
import {
  AnthropicProvider,
  supportsAdaptiveThinking,
  toAnthropicMessages,
} from "../src/provider/anthropic.js";
import { hashAssistantFields } from "../src/provider/continuation.js";
import type { ProviderEvent } from "../src/provider/types.js";
import type { Message } from "../src/types.js";

function sse(type: string, payload: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

const messageStart = sse("message_start", {
  type: "message_start",
  message: {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: {
      input_tokens: 10,
      cache_creation_input_tokens: 2,
      cache_read_input_tokens: 3,
      output_tokens: 0,
    },
  },
});

const messageEnd = (stopReason: string, outputTokens: number): string =>
  sse("message_delta", {
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: outputTokens },
  }) + sse("message_stop", { type: "message_stop" });

function textEvents(text: string, index = 0): string {
  return (
    sse("content_block_start", {
      type: "content_block_start",
      index,
      content_block: { type: "text", text: "" },
    }) +
    sse("content_block_delta", {
      type: "content_block_delta",
      index,
      delta: { type: "text_delta", text },
    }) +
    sse("content_block_stop", { type: "content_block_stop", index })
  );
}

function toolEvents(json: string, index = 0, id = "toolu_current"): string {
  return (
    sse("content_block_start", {
      type: "content_block_start",
      index,
      content_block: { type: "tool_use", id, name: "echo", input: {} },
    }) +
    sse("content_block_delta", {
      type: "content_block_delta",
      index,
      delta: { type: "input_json_delta", partial_json: json },
    }) +
    sse("content_block_stop", { type: "content_block_stop", index })
  );
}

function thinkingEvents(block: { type: "thinking" | "redacted_thinking"; [field: string]: string }, index = 0): string {
  return sse("content_block_start", { type: "content_block_start", index, content_block: block }) +
    sse("content_block_stop", { type: "content_block_stop", index });
}

function agentFixture(responses: string[]) {
  const bodies: { messages: unknown[] }[] = [];
  const client = new Anthropic({
    apiKey: "test",
    fetch: async (_url, init) => {
      const response = responses[bodies.length];
      bodies.push(JSON.parse(String(init?.body)));
      if (response === undefined) throw new Error("Unexpected Messages request");
      return new Response(response, { headers: { "content-type": "text/event-stream" } });
    },
    maxRetries: 0,
  });
  const execute = vi.fn(async () => ({ content: "lookup failed", isError: true }));
  const provider = new AnthropicProvider({ apiKey: "test", client });
  return {
    bodies,
    execute,
    async run(messages: Message[], contextBudget: Parameters<typeof runAgent>[0]["contextBudget"] = false) {
      for await (const _event of runAgent({
        provider,
        model: "test-model",
        messages,
        tools: [{
          name: "echo", description: "Test tool", capabilities: ["read"],
          inputSchema: z.object({ text: z.string().optional() }),
          summarize: () => "echo", execute,
        }],
        context: { root: process.cwd() },
        permissions: new PermissionPolicy({ preset: "plan", interactive: false }),
        contextBudget,
      })) {
        // Consume the full agent run so any tool execution and follow-up are observed.
      }
    },
  };
}

type Captured = { url: string; body: Record<string, unknown> };

function startServer(
  responseFor: (body: Record<string, unknown>) => string,
): Promise<{ server: Server; baseURL: string; requests: Captured[] }> {
  const requests: Captured[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
        string,
        unknown
      >;
      requests.push({ url: request.url ?? "", body });
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      response.end(responseFor(body));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("failed to start mock server");
      }
      resolve({
        server,
        baseURL: `http://127.0.0.1:${address.port}`,
        requests,
      });
    });
  });
}

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function collect(events: AsyncIterable<ProviderEvent>) {
  const out: ProviderEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe("supportsAdaptiveThinking", () => {
  it("recognises current models and rejects older families", () => {
    expect(supportsAdaptiveThinking("claude-opus-5-5")).toBe(true);
    expect(supportsAdaptiveThinking("claude-sonnet-5-5")).toBe(true);
    expect(supportsAdaptiveThinking("claude-opus-4-8")).toBe(true);
    expect(supportsAdaptiveThinking("claude-sonnet-4-6")).toBe(true);
    expect(supportsAdaptiveThinking("claude-haiku-4-5")).toBe(false);
    expect(supportsAdaptiveThinking("gpt-4o")).toBe(false);
  });
});

describe("toAnthropicMessages", () => {
  it("extracts system text and groups consecutive tool results", () => {
    const messages: Message[] = [
      { role: "system", content: "one" },
      { role: "system", content: "two" },
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "a", name: "read_file", arguments: '{"path":"a.ts"}' },
          { id: "b", name: "grep", arguments: '{"pattern":"x"}' },
        ],
      },
      { role: "tool", toolCallId: "a", content: "contents a" },
      { role: "tool", toolCallId: "b", content: "contents b" },
    ];

    const converted = toAnthropicMessages(messages);
    expect(converted.system).toBe("one\n\ntwo");
    expect(converted.messages).toEqual([
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "a",
            name: "read_file",
            input: { path: "a.ts" },
          },
          {
            type: "tool_use",
            id: "b",
            name: "grep",
            input: { pattern: "x" },
          },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "a", content: "contents a" },
          { type: "tool_result", tool_use_id: "b", content: "contents b" },
        ],
      },
    ]);
  });

  it("replays signed thinking blocks stored in providerData", () => {
    const converted = toAnthropicMessages([
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "answer",
        providerData: {
          anthropic: {
            thinking: [
              { type: "thinking", thinking: "plan", signature: "sig" },
            ],
          },
        },
      },
    ]);

    expect(converted.messages[1]).toEqual({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "plan", signature: "sig" },
        { type: "text", text: "answer" },
      ],
    });
  });

  it("drops thinking blocks when the request prefix changed", () => {
    const call = { id: "call_1", name: "echo", arguments: '{"text":"hi"}' };
    const message: Message = {
      role: "assistant",
      content: "answer",
      toolCalls: [call],
      continuation: {
        protocol: "anthropic-messages",
        endpoint: "endpoint",
        model: "claude-opus-5-5",
        scope: "prefix",
        messageAnchor: hashAssistantFields("answer", [call]),
        historyAnchor: "stale-anchor",
        payload: {
          content: [
            { type: "thinking", thinking: "plan", signature: "sig" },
            { type: "text", text: "answer" },
            {
              type: "tool_use",
              id: "call_1",
              name: "echo",
              input: { text: "hi" },
            },
          ],
        },
      },
    };

    const converted = toAnthropicMessages(
      [{ role: "user", content: "go" }, message],
      { endpoint: "endpoint", model: "claude-opus-5-5", allowLegacy: false },
      [],
    );

    expect(converted.messages[1]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "answer" },
        {
          type: "tool_use",
          id: "call_1",
          name: "echo",
          input: { text: "hi" },
        },
      ],
    });
  });

  it("falls back to an empty object for malformed tool arguments", () => {
    const converted = toAnthropicMessages([
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "a", name: "broken", arguments: "{nope" }],
      },
    ]);

    expect(converted.messages[0]).toEqual({
      role: "assistant",
      content: [{ type: "tool_use", id: "a", name: "broken", input: {} }],
    });
  });
});

describe("AnthropicProvider", () => {
  it.each([
    ["max_tokens", messageEnd("max_tokens", 5), "unfinished tool call"],
    ["malformed arguments", messageEnd("tool_use", 5), "malformed tool arguments"],
    ["missing message_stop", "", "stream ended without producing a Message"],
  ])("does not execute or record a tool after %s", async (_case, end, error) => {
    const { bodies, execute, run } = agentFixture([
      messageStart + toolEvents('{"text":') + end,
      messageStart + textEvents("unexpected follow-up") + messageEnd("end_turn", 3),
    ]);
    const messages: Message[] = [{ role: "user", content: "go" }];

    await expect(run(messages)).rejects.toThrow(error);
    expect(execute).not.toHaveBeenCalled();
    expect(bodies).toHaveLength(1);
    expect(messages).toEqual([{ role: "user", content: "go" }]);
  });

  it("preserves the signed request prefix and flags failed results when pruning would change the prefix", async () => {
    const signed = { type: "thinking", thinking: "plan", signature: "sig-original" } as const;
    const redacted = { type: "redacted_thinking", data: "opaque-data" } as const;
    const { bodies, execute, run } = agentFixture([
      messageStart + thinkingEvents(signed) + thinkingEvents(redacted, 1) +
        toolEvents("{}", 2) + messageEnd("tool_use", 5),
      messageStart + textEvents("recovered") + messageEnd("end_turn", 3),
    ]);
    const messages: Message[] = [
      { role: "user", content: "earlier" },
      { role: "assistant", content: "", toolCalls: [{ id: "toolu_old", name: "echo", arguments: "{}" }] },
      { role: "tool", toolCallId: "toolu_old", content: "old result ".repeat(1000) },
      { role: "assistant", content: "old answer" },
      { role: "user", content: "go" },
    ];

    await run(messages, { window: 16_000, pruneAt: 0.1, summarizeAt: 0.9, keepRecentToolResults: 1 });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]?.messages).toEqual([
      ...bodies[0]!.messages,
      { role: "assistant", content: [signed, redacted, { type: "tool_use", id: "toolu_current", name: "echo", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_current", content: "lookup failed", is_error: true }] },
    ]);
  });

  it("shrinks only the latest result when a multi-step signed tool round exceeds the budget", async () => {
    const signed = { type: "thinking", thinking: "plan", signature: "sig-original" } as const;
    const { bodies, execute, run } = agentFixture([
      messageStart + thinkingEvents(signed) + toolEvents("{}", 1) + messageEnd("tool_use", 5),
      messageStart + toolEvents("{}", 0, "toolu_second") + messageEnd("tool_use", 5),
      messageStart + textEvents("recovered") + messageEnd("end_turn", 3),
    ]);
    execute.mockResolvedValueOnce({ content: "first result", isError: false });
    execute.mockResolvedValueOnce({ content: "oversized result ".repeat(3000), isError: true });
    const messages: Message[] = [{ role: "user", content: "original request ".repeat(200) }];

    await run(messages, { window: 8000, reserveOutputTokens: 0 });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(bodies).toHaveLength(3);
    expect(bodies[2]?.messages).toEqual([
      ...bodies[1]!.messages,
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_second", name: "echo", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_second", content: expect.stringContaining("elided"), is_error: true }] },
    ]);
    expect(bodies[1]?.messages).toContainEqual({
      role: "assistant",
      content: [signed, { type: "tool_use", id: "toolu_current", name: "echo", input: {} }],
    });
  });

  it("does not replay an unfinished thinking block from a text-only max_tokens response", async () => {
    const { bodies, run } = agentFixture([
      messageStart + thinkingEvents({ type: "thinking", thinking: "unfinished", signature: "" }) +
        textEvents("partial answer", 1) + messageEnd("max_tokens", 5),
      messageStart + textEvents("recovered") + messageEnd("end_turn", 3),
    ]);
    const messages: Message[] = [{ role: "user", content: "go" }];
    await run(messages);
    expect(messages.at(-1)).toEqual({ role: "assistant", content: "partial answer" });

    messages.push({ role: "user", content: "continue" });
    await run(messages);
    expect(bodies[1]?.messages).toEqual([
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "text", text: "partial answer" }] },
      { role: "user", content: "continue" },
    ]);
  });

  it("normalizes thinking, text, tool calls, and usage", async () => {
    const { server, baseURL, requests } = await startServer(
      () =>
        messageStart +
        sse("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking", thinking: "", signature: "" },
        }) +
        sse("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "pondering" },
        }) +
        sse("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "signature_delta", signature: "sig-1" },
        }) +
        sse("content_block_stop", { type: "content_block_stop", index: 0 }) +
        textEvents("Hello", 1) +
        sse("content_block_start", {
          type: "content_block_start",
          index: 2,
          content_block: {
            type: "tool_use",
            id: "call_1",
            name: "echo",
            input: {},
          },
        }) +
        sse("content_block_delta", {
          type: "content_block_delta",
          index: 2,
          delta: {
            type: "input_json_delta",
            partial_json: '{"text":"hi"}',
          },
        }) +
        sse("content_block_stop", { type: "content_block_stop", index: 2 }) +
        messageEnd("tool_use", 15),
    );
    servers.push(server);

    const provider = new AnthropicProvider({ apiKey: "test", baseURL });
    const events = await collect(
      provider.stream({
        model: "claude-opus-5-5",
        messages: [{ role: "user", content: "hi" }],
        tools: [],
      }),
    );

    const reasoning = events
      .filter((event) => event.type === "reasoning")
      .map((event) => (event.type === "reasoning" ? event.delta : ""))
      .join("");
    expect(reasoning).toBe("pondering");

    const text = events
      .filter((event) => event.type === "text")
      .map((event) => (event.type === "text" ? event.delta : ""))
      .join("");
    expect(text).toBe("Hello");

    const done = events.find((event) => event.type === "done");
    expect(done?.type === "done" ? done.message : null).toMatchObject({
      content: "Hello",
      toolCalls: [
        { id: "call_1", name: "echo", arguments: '{"text":"hi"}' },
      ],
      continuation: {
        protocol: "anthropic-messages",
        endpoint: createHash("sha256").update(baseURL).digest("hex"),
        model: "claude-opus-5-5",
        scope: "prefix",
        messageAnchor: expect.any(String),
        historyAnchor: expect.any(String),
        payload: {
          content: [
            { type: "thinking", thinking: "pondering", signature: "sig-1" },
            { type: "text", text: "Hello" },
            {
              type: "tool_use",
              id: "call_1",
              name: "echo",
              input: { text: "hi" },
            },
          ],
        },
      },
    });
    expect(done?.type === "done" ? done.usage : null).toEqual({
      inputTokens: 15,
      outputTokens: 15,
    });
    expect(done?.type === "done" ? done.finishReason : null).toBe("tool_use");

    if (done?.type !== "done") throw new Error("Missing provider completion");
    const messages: Message[] = [
      { role: "user", content: "hi" },
      { role: "assistant", ...done.message },
      { role: "tool", content: "hi", toolCallId: "call_1" },
    ];
    await collect(provider.stream({ model: "claude-opus-5-5", messages, tools: [] }));
    await collect(provider.stream({ model: "claude-sonnet-5-5", messages, tools: [] }));
    const other = await startServer(() => messageStart + textEvents("ok") + messageEnd("end_turn", 2));
    servers.push(other.server);
    const otherProvider = new AnthropicProvider({ apiKey: "test", baseURL: other.baseURL });
    await collect(otherProvider.stream({ model: "claude-opus-5-5", messages, tools: [] }));

    expect(JSON.stringify(requests[1]?.body.messages)).toContain("sig-1");
    expect(JSON.stringify(requests[2]?.body.messages)).not.toContain("sig-1");
    expect(JSON.stringify(other.requests[0]?.body.messages)).not.toContain("sig-1");
    expect(JSON.stringify(other.requests[0]?.body.messages)).toContain("tool_result");
  });

  it("sends system, tools, thinking config, and grouped tool results", async () => {
    const { server, baseURL, requests } = await startServer(
      () => messageStart + textEvents("ok") + messageEnd("end_turn", 2),
    );
    servers.push(server);

    const provider = new AnthropicProvider({
      apiKey: "test",
      baseURL,
      maxTokens: 1234,
    });
    const messages: Message[] = [
      { role: "system", content: "You are Cooper." },
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "working",
        toolCalls: [
          { id: "a", name: "read_file", arguments: '{"path":"a.ts"}' },
          { id: "b", name: "grep", arguments: '{"pattern":"x"}' },
        ],
      },
      { role: "tool", toolCallId: "a", content: "contents a" },
      { role: "tool", toolCallId: "b", content: "contents b" },
    ];

    await collect(
      provider.stream({
        model: "claude-opus-5-5",
        messages,
        tools: [
          {
            name: "read_file",
            description: "Read a file",
            parameters: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
            },
          },
        ],
      }),
    );

    const request = requests[0];
    expect(request?.url).toBe("/v1/messages");
    const body = request?.body;
    expect(body?.["system"]).toBe("You are Cooper.");
    expect(body?.["max_tokens"]).toBe(1234);
    expect(body?.["thinking"]).toEqual({
      type: "adaptive",
      display: "summarized",
    });
    expect(body?.["tools"]).toEqual([
      {
        name: "read_file",
        description: "Read a file",
        input_schema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    ]);

    const sent = body?.["messages"] as Array<Record<string, unknown>>;
    expect(sent[1]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "working" },
        { type: "tool_use", id: "a", name: "read_file", input: { path: "a.ts" } },
        { type: "tool_use", id: "b", name: "grep", input: { pattern: "x" } },
      ],
    });
    expect(sent[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "a", content: "contents a" },
        { type: "tool_result", tool_use_id: "b", content: "contents b" },
      ],
    });
  });

  it("omits the thinking config for models that do not support it", async () => {
    const { server, baseURL, requests } = await startServer(
      () => messageStart + textEvents("ok") + messageEnd("end_turn", 2),
    );
    servers.push(server);

    const provider = new AnthropicProvider({ apiKey: "test", baseURL });
    await collect(
      provider.stream({
        model: "claude-haiku-4-5",
        messages: [{ role: "user", content: "hi" }],
        tools: [],
      }),
    );

    expect(requests[0]?.body["thinking"]).toBeUndefined();
  });
});
