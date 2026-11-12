import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { createSession, loadSession, readFileTool } from "@cooper/core";
import { afterEach, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { runHeadless } from "../src/headless.js";
import { createProvider } from "../src/provider.js";

type WireEvent = { type: string; [key: string]: unknown };
const servers: Server[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture(streams: WireEvent[][]) {
  const requests: { method?: string; path?: string; body: Record<string, unknown> }[] = [];
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request.setEncoding("utf8")) raw += chunk;
    const events = streams[requests.length];
    requests.push({ method: request.method, path: request.url, body: JSON.parse(raw) });
    if (!events) {
      response.writeHead(500);
      response.end("Unexpected Responses API request");
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const [sequence_number, event] of events.entries()) {
      const data = JSON.stringify({ ...event, sequence_number });
      response.write("event: " + event.type + "\ndata: " + data + "\n\n");
    }
    response.end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP port");

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cooper-responses-"));
  roots.push(root);
  await fs.writeFile(path.join(root, "config.json"), JSON.stringify({
    protocol: "openai-responses",
    model: "test-model",
    apiKey: "test-key",
    baseURL: "http://127.0.0.1:" + address.port + "/v1",
    maxOutputTokens: 1024,
    showReasoning: true,
  }));
  await fs.writeFile(path.join(root, "answer.txt"), "from the workspace");
  return { requests, root, config: loadConfig({ home: root }) };
}

function completed(output: unknown[]): WireEvent {
  return {
    type: "response.completed",
    response: {
      object: "response",
      status: "completed",
      output,
      usage: { input_tokens: 42, output_tokens: 12, output_tokens_details: { reasoning_tokens: 5 } },
    },
  };
}

function message(id: string, text: string) {
  return {
    type: "message", id, role: "assistant", status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
}

const functionCall = {
  type: "function_call",
  id: "fc_item_1",
  call_id: "call_tool_1",
  name: "read_file",
  arguments: '{"path":"answer.txt"}',
  status: "completed",
};

it("uses Responses from CLI config and replays ordered items through a tool turn and session resume", async () => {
  const reasoning = {
    type: "reasoning", id: "rs_1", summary: [], encrypted_content: "opaque-test-state",
  };
  const finalAnswer = message("msg_1", "Read successfully.");
  const { config, requests, root } = await fixture([
    [
      { type: "response.reasoning_summary_text.delta", delta: "Display only.\n" },
      { type: "response.output_item.done", output_index: 0, item: reasoning },
      { type: "response.function_call_arguments.delta", item_id: functionCall.id, delta: '{"path":' },
      { type: "response.function_call_arguments.delta", item_id: functionCall.id, delta: '"answer.txt"}' },
      { type: "response.function_call_arguments.done", item_id: functionCall.id, arguments: functionCall.arguments },
      { type: "response.output_item.done", output_index: 1, item: functionCall },
      completed([{ ...reasoning, encrypted_content: null }, functionCall]),
    ],
    [{ type: "response.output_text.delta", delta: "Read " }, completed([finalAnswer])],
    [completed([message("msg_2", "Resumed.")])],
    [completed([message("msg_3", "Changed prefix.")])],
  ]);
  const session = createSession({ cwd: root, model: config.model, home: root });

  async function run(prompt: string, resumed?: ReturnType<typeof loadSession>, instructions = "") {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runHeadless({
      config, root, mode: "plan", prompt, provider: createProvider(config),
      instructions: { text: instructions, sources: [] },
      showReasoning: config.showReasoning,
      tools: [readFileTool],
      session: resumed ? undefined : session,
      resumed,
      out: { write: (text) => stdout.push(text) },
      err: { write: (text) => stderr.push(text) },
    });
    return { code, stdout: stdout.join(""), stderr: stderr.join("") };
  }

  const first = await run("Read answer.txt");
  expect(first).toMatchObject({ code: 0, stdout: "Read successfully.\n" });
  expect(first.stderr).toContain("Display only.");
  expect(requests[0]).toMatchObject({
    method: "POST", path: "/v1/responses",
    body: {
      model: "test-model", stream: true, store: false,
      include: ["reasoning.encrypted_content"], max_output_tokens: 1024,
      reasoning: { summary: "auto" },
      tools: [{ type: "function", name: "read_file", strict: false, parameters: expect.any(Object) }],
    },
  });
  expect(requests[0]?.body).not.toHaveProperty("messages");
  expect(requests[0]?.body).not.toHaveProperty("previous_response_id");
  const firstInput = requests[0]?.body.input as unknown[];
  const toolInput = requests[1]?.body.input as unknown[];
  expect(toolInput).toEqual([
    ...firstInput, reasoning, functionCall,
    { type: "function_call_output", call_id: functionCall.call_id, output: expect.stringContaining("from the workspace") },
  ]);

  const resumed = loadSession(session.file);
  expect(resumed.messages).toContainEqual(expect.objectContaining({
    role: "assistant",
    continuation: expect.objectContaining({ protocol: "openai-responses", payload: [reasoning, functionCall] }),
  }));
  expect(await fs.readFile(session.file, "utf8")).not.toContain("Display only.");
  expect(await run("Continue", resumed)).toMatchObject({ code: 0, stdout: "Resumed.\n" });
  expect((requests[2]?.body.input as unknown[]).slice(0, toolInput.length + 1)).toEqual([
    ...toolInput, finalAnswer,
  ]);

  expect(await run("Continue", resumed, "Changed project instructions")).toMatchObject({ code: 0 });
  const editedInput = requests[3]?.body.input as unknown[];
  expect(editedInput).not.toContainEqual(reasoning);
  expect(editedInput).toContainEqual(functionCall);
});

it.each([
  {
    event: {
      type: "response.incomplete",
      response: { incomplete_details: { reason: "max_output_tokens" }, output: [functionCall] },
    },
    error: "incomplete response (max_output_tokens)",
  },
  {
    event: { type: "response.failed", response: { error: { message: "upstream generation failed" } } },
    error: "upstream generation failed",
  },
  { event: undefined, error: "stream ended before a terminal event" },
])("fails without executing a tool after $error", async ({ event, error }) => {
  const itemDone = { type: "response.output_item.done", output_index: 0, item: functionCall };
  const { config, requests, root } = await fixture([[itemDone, ...(event ? [event] : [])]]);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const execute = vi.fn(readFileTool.execute);
  const code = await runHeadless({
    config, root, mode: "plan", prompt: "Read answer.txt", provider: createProvider(config),
    instructions: { text: "", sources: [] }, showReasoning: false, tools: [{ ...readFileTool, execute }],
    out: { write: (text) => stdout.push(text) },
    err: { write: (text) => stderr.push(text) },
  });
  expect(code).toBe(1);
  expect(stdout).toEqual([]);
  expect(stderr.join("")).toContain(error);
  expect(execute).not.toHaveBeenCalled();
  expect(requests).toHaveLength(1);
});
