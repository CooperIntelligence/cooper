import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  AnthropicProvider,
  supportsAdaptiveThinking,
  toAnthropicMessages,
} from "../src/provider/anthropic.js";
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
    expect(done?.type === "done" ? done.message : null).toEqual({
      content: "Hello",
      toolCalls: [
        { id: "call_1", name: "echo", arguments: '{"text":"hi"}' },
      ],
      providerData: {
        anthropic: {
          endpoint: createHash("sha256").update(baseURL).digest("hex"),
          model: "claude-opus-5-5",
          thinking: [
            { type: "thinking", thinking: "pondering", signature: "sig-1" },
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
