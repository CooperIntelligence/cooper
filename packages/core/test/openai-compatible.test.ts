import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { OpenAICompatibleProvider } from "../src/provider/openai-compatible.js";
import type { ProviderEvent } from "../src/provider/types.js";

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
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
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

    const text = events
      .filter((event) => event.type === "text")
      .map((event) => (event.type === "text" ? event.delta : ""))
      .join("");
    expect(text).toBe("ok");
  });
});
