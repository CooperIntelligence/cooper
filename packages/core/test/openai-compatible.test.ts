import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { runAgent } from "../src/agent.js";
import { PermissionPolicy } from "../src/permissions.js";
import { OpenAICompatibleProvider } from "../src/provider/openai-compatible.js";
import type { ChatRequest, ProviderEvent } from "../src/provider/types.js";
import type { Message } from "../src/types.js";

function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function chunk(delta: unknown, finishReason: string | null = null) {
  return {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 0,
    model: "test-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

describe("OpenAICompatibleProvider", () => {
  const servers: Server[] = [];

  afterEach(async () => {
    vi.unstubAllGlobals();
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.each([null, "length", "stop"])("does not execute or record streamed calls with finish_reason %s", async (reason) => {
    const toolDelta = sse(chunk({
      tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "echo", arguments: "{}" } }],
    }));
    const fetch = vi.fn(async () => new Response(
      fetch.mock.calls.length === 1
        ? toolDelta + (reason === null ? "" : sse(chunk({}, reason)) + "data: [DONE]\n\n")
        : sse(chunk({ content: "unexpected follow-up" }, "stop")) + "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    ));
    vi.stubGlobal("fetch", fetch);
    const execute = vi.fn(async () => ({ content: "unexpected execution" }));
    const messages: Message[] = [{ role: "user", content: "go" }];

    async function run() {
      for await (const _event of runAgent({
        provider: new OpenAICompatibleProvider({ apiKey: "test" }),
        model: "test-model",
        messages,
        tools: [{
          name: "echo", description: "Test tool", capabilities: ["read"],
          inputSchema: z.object({}), summarize: () => "echo", execute,
        }],
        context: { root: process.cwd() },
        permissions: new PermissionPolicy({ preset: "plan", interactive: false }),
        contextBudget: false,
      })) {
        // Consume the full run and check whether a tool actually executed.
      }
    }

    await expect(run()).rejects.toThrow(reason === null ? "without a finish_reason" : `finish_reason: ${reason}`);
    expect(execute).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(messages).toEqual([{ role: "user", content: "go" }]);
  });

  it("normalizes streamed text and split tool-call deltas", async () => {
    const server = createServer((request, response) => {
      request.resume();
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(sse(chunk({ role: "assistant", content: "Hel" })));
      response.write(sse(chunk({ content: "lo" })));
      response.write(
        sse(
          chunk({
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                type: "function",
                function: { name: "echo", arguments: '{"text":' },
              },
            ],
          }),
        ),
      );
      response.write(
        sse(
          chunk({
            tool_calls: [
              { index: 0, function: { arguments: '"hi"}' } },
            ],
          }),
        ),
      );
      response.write(sse(chunk({}, "tool_calls")));
      response.end("data: [DONE]\n\n");
    });
    servers.push(server);

    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to start mock server");
    }

    const provider = new OpenAICompatibleProvider({
      apiKey: "test",
      baseURL: `http://127.0.0.1:${address.port}/v1`,
    });

    const events: ProviderEvent[] = [];
    for await (const event of provider.stream({
      model: "test-model",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
    })) {
      events.push(event);
    }

    const text = events
      .filter((event) => event.type === "text")
      .map((event) => (event.type === "text" ? event.delta : ""))
      .join("");
    expect(text).toBe("Hello");

    const done = events.find((event) => event.type === "done");
    expect(done?.type === "done" ? done.message.toolCalls : []).toEqual([
      { id: "call_1", name: "echo", arguments: '{"text":"hi"}' },
    ]);
    expect(done?.type === "done" ? done.message.content : "").toBe("Hello");
  });

  it("surfaces reasoning deltas without mixing them into the answer", async () => {
    const server = createServer((request, response) => {
      request.resume();
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(sse(chunk({ reasoning_content: "think " })));
      response.write(sse(chunk({ reasoning_content: "hard" })));
      response.write(sse(chunk({ content: "answer" })));
      response.end(sse(chunk({}, "stop")) + "data: [DONE]\n\n");
    });
    servers.push(server);

    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to start mock server");
    }

    const provider = new OpenAICompatibleProvider({
      apiKey: "test",
      baseURL: `http://127.0.0.1:${address.port}/v1`,
    });

    const events: ProviderEvent[] = [];
    for await (const event of provider.stream({
      model: "test-model",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
    })) {
      events.push(event);
    }

    const reasoning = events
      .filter((event) => event.type === "reasoning")
      .map((event) => (event.type === "reasoning" ? event.delta : ""))
      .join("");
    expect(reasoning).toBe("think hard");

    const done = events.find((event) => event.type === "done");
    expect(done?.type === "done" ? done.message.content : "").toBe("answer");
  });

  it("reports token usage from the final chunk", async () => {
    const server = createServer((request, response) => {
      request.resume();
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(sse(chunk({ content: "ok" })));
      response.write(sse(chunk({}, "stop")));
      response.write(
        sse({
          id: "chatcmpl-test",
          object: "chat.completion.chunk",
          created: 0,
          model: "test-model",
          choices: [],
          usage: { prompt_tokens: 1234, completion_tokens: 56, total_tokens: 1290 },
        }),
      );
      response.end("data: [DONE]\n\n");
    });
    servers.push(server);

    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to start mock server");
    }

    const provider = new OpenAICompatibleProvider({
      apiKey: "test",
      baseURL: `http://127.0.0.1:${address.port}/v1`,
    });

    const events: ProviderEvent[] = [];
    for await (const event of provider.stream({
      model: "test-model",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
    })) {
      events.push(event);
    }

    const done = events.find((event) => event.type === "done");
    expect(done?.type === "done" ? done.usage : undefined).toEqual({
      inputTokens: 1234,
      outputTokens: 56,
    });
  });

  it("retries without stream_options when an endpoint rejects them", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (data: Buffer) => chunks.push(data));
      request.on("end", () => {
        bodies.push(
          JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
            string,
            unknown
          >,
        );

        if (bodies.length === 1) {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              error: {
                message:
                  "Unrecognized request argument supplied: stream_options",
                type: "invalid_request_error",
              },
            }),
          );
          return;
        }

        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(sse(chunk({ content: "ok" })));
        response.write(sse(chunk({}, "stop")));
        response.end("data: [DONE]\n\n");
      });
    });
    servers.push(server);

    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to start mock server");
    }

    const provider = new OpenAICompatibleProvider({
      apiKey: "test",
      baseURL: `http://127.0.0.1:${address.port}/v1`,
    });

    const events: ProviderEvent[] = [];
    for await (const event of provider.stream({
      model: "test-model",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
    })) {
      events.push(event);
    }

    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.stream_options).toEqual({ include_usage: true });
    expect(bodies[1]?.stream_options).toBeUndefined();
    expect(events).toEqual([
      { type: "text", delta: "ok" },
      { type: "done", message: { content: "ok", toolCalls: [] }, finishReason: "stop" },
    ]);
  });

  it("captures reasoning_content and replays it on the assistant message", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        bodies.push(
          JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
            string,
            unknown
          >,
        );
        response.writeHead(200, { "content-type": "text/event-stream" });
        if (bodies.length === 1) {
          response.write(sse(chunk({ role: "assistant", reasoning_content: "think " })));
          response.write(sse(chunk({ reasoning_content: "hard" })));
          response.write(
            sse(
              chunk({
                tool_calls: [
                  {
                    index: 0,
                    id: "call_1",
                    type: "function",
                    function: { name: "echo", arguments: '{"text":"hi"}' },
                  },
                ],
              }),
            ),
          );
          response.end(sse(chunk({}, "tool_calls")) + "data: [DONE]\n\n");
        } else {
          response.write(sse(chunk({ content: "done" })));
          response.end(sse(chunk({}, "stop")) + "data: [DONE]\n\n");
        }
      });
    });
    servers.push(server);

    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to start mock server");
    }

    const provider = new OpenAICompatibleProvider({
      apiKey: "test",
      baseURL: `http://127.0.0.1:${address.port}/v1`,
    });
    const tools = [
      {
        name: "echo",
        description: "Echo text.",
        parameters: { type: "object", properties: {} },
      },
    ];
    const messages: Message[] = [{ role: "user", content: "hi" }];
    const collect = async (request: ChatRequest) => {
      const events: ProviderEvent[] = [];
      for await (const event of provider.stream(request)) events.push(event);
      return events;
    };

    const first = await collect({ model: "deepseek-v4-pro", messages, tools });
    const done = first.find((event) => event.type === "done");
    if (done?.type !== "done") throw new Error("missing completion");
    expect(done.message.continuation).toMatchObject({
      protocol: "openai-chat",
      model: "deepseek-v4-pro",
      scope: "message",
      messageAnchor: expect.any(String),
      payload: { field: "reasoning_content", reasoningContent: "think hard" },
    });

    messages.push({
      role: "assistant",
      content: done.message.content,
      toolCalls: done.message.toolCalls,
      continuation: done.message.continuation,
    });
    messages.push({ role: "tool", toolCallId: "call_1", content: "hi" });
    await collect({ model: "deepseek-v4-pro", messages, tools });

    const replay = bodies[1]?.messages as Array<Record<string, unknown>>;
    expect(replay[1]).toMatchObject({
      role: "assistant",
      content: null,
      reasoning_content: "think hard",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "echo", arguments: '{"text":"hi"}' },
        },
      ],
    });
  });

  it("does not replay reasoning to a different endpoint or model", async () => {
    const firstBodies: Array<Record<string, unknown>> = [];
    const otherBodies: Array<Record<string, unknown>> = [];

    const firstServer = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        firstBodies.push(
          JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
            string,
            unknown
          >,
        );
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(sse(chunk({ role: "assistant", reasoning_content: "secret" })));
        response.write(sse(chunk({ content: "answer" })));
        response.end(sse(chunk({}, "stop")) + "data: [DONE]\n\n");
      });
    });
    const otherServer = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        otherBodies.push(
          JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
            string,
            unknown
          >,
        );
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(sse(chunk({ content: "ok" })));
        response.end(sse(chunk({}, "stop")) + "data: [DONE]\n\n");
      });
    });
    servers.push(firstServer, otherServer);

    for (const server of [firstServer, otherServer]) {
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
    }
    const firstAddress = firstServer.address();
    const otherAddress = otherServer.address();
    if (
      !firstAddress ||
      typeof firstAddress === "string" ||
      !otherAddress ||
      typeof otherAddress === "string"
    ) {
      throw new Error("failed to start mock servers");
    }

    const first = new OpenAICompatibleProvider({
      apiKey: "test",
      baseURL: `http://127.0.0.1:${firstAddress.port}/v1`,
    });
    const other = new OpenAICompatibleProvider({
      apiKey: "test",
      baseURL: `http://127.0.0.1:${otherAddress.port}/v1`,
    });
    const messages: Message[] = [{ role: "user", content: "hi" }];
    let done: ProviderEvent | undefined;
    for await (const event of first.stream({
      model: "deepseek-v4-pro",
      messages,
      tools: [],
    })) {
      if (event.type === "done") done = event;
    }
    if (done?.type !== "done") throw new Error("missing completion");

    const continuation = done.message.continuation;
    expect(continuation).toBeDefined();
    const assistant: Message = {
      role: "assistant",
      content: done.message.content,
      continuation,
    };

    // Same endpoint, different model: drop.
    for await (const _ of first.stream({
      model: "kimi-k3.1-pro",
      messages: [...messages, assistant],
      tools: [],
    })) {
      // consume
    }
    // Different endpoint, same model: drop.
    for await (const _ of other.stream({
      model: "deepseek-v4-pro",
      messages: [...messages, assistant],
      tools: [],
    })) {
      // consume
    }

    expect(JSON.stringify(firstBodies[1]?.messages)).not.toContain("reasoning_content");
    expect(JSON.stringify(otherBodies[0]?.messages)).not.toContain("reasoning_content");
  });
});
