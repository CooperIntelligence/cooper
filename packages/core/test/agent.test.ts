import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  runAgent,
  type AgentEvent,
  type ApprovalRequest,
} from "../src/agent.js";
import type {
  ChatRequest,
  Provider,
  ProviderEvent,
} from "../src/provider/types.js";
import { PermissionPolicy } from "../src/permissions.js";
import { readFileTool } from "../src/tools/fs.js";
import type { Tool } from "../src/tools/tool.js";
import type { Message } from "../src/types.js";

/** Read-only tools never prompt, so a non-interactive policy is enough. */
const nonInteractive = new PermissionPolicy({
  preset: "ask",
  interactive: false,
});

const echoSchema = z.object({ text: z.string() });

const echoTool: Tool<typeof echoSchema> = {
  name: "echo",
  description: "Echoes the given text.",
  inputSchema: echoSchema,
  capabilities: ["read"],
  async execute(input) {
    return { content: `echo: ${input.text}` };
  },
};

class ScriptedProvider implements Provider {
  private calls = 0;

  async *stream(_request: ChatRequest): AsyncIterable<ProviderEvent> {
    this.calls += 1;

    if (this.calls === 1) {
      yield {
        type: "done",
        message: {
          content: "",
          toolCalls: [{ id: "call_1", name: "echo", arguments: '{"text":"hi"}' }],
        },
        finishReason: "tool_calls",
      };
      return;
    }

    yield { type: "text", delta: "All done." };
    yield {
      type: "done",
      message: { content: "All done.", toolCalls: [] },
      finishReason: "stop",
    };
  }
}

describe("runAgent", () => {
  it("executes tool calls and feeds results back to the model", async () => {
    const messages: Message[] = [
      { role: "system", content: "test" },
      { role: "user", content: "say hi" },
    ];
    const events: AgentEvent[] = [];
    let approvalCalls = 0;

    for await (const event of runAgent({
      provider: new ScriptedProvider(),
      model: "test-model",
      tools: [echoTool],
      messages,
      context: { root: process.cwd() },
      permissions: nonInteractive,
      approve: () => {
        approvalCalls += 1;
        return "allow";
      },
    })) {
      events.push(event);
    }

    // Read-only tools must never ask for approval.
    expect(approvalCalls).toBe(0);

    const toolEnd = events.find((event) => event.type === "tool-end");
    expect(toolEnd).toBeDefined();
    expect(
      toolEnd?.type === "tool-end" ? toolEnd.result.content : "",
    ).toBe("echo: hi");
    expect(toolEnd?.type === "tool-end" ? toolEnd.isError : true).toBe(false);

    expect(
      events.some(
        (event) => event.type === "assistant-done" && event.content === "All done.",
      ),
    ).toBe(true);

    expect(messages).toHaveLength(5);
    expect(messages[2]).toMatchObject({ role: "assistant" });
    expect(messages[3]).toMatchObject({
      role: "tool",
      toolCallId: "call_1",
      content: "echo: hi",
    });
    expect(messages[4]).toMatchObject({ role: "assistant", content: "All done." });
  });

  it("carries opaque provider continuation data into history and events", async () => {
    const providerData = {
      anthropic: {
        thinking: [
          { type: "thinking", thinking: "plan", signature: "sig-1" },
        ],
      },
    };
    const provider: Provider = {
      async *stream() {
        yield {
          type: "done",
          message: { content: "answer", toolCalls: [], providerData },
          finishReason: "end_turn",
        };
      },
    };
    const messages: Message[] = [{ role: "user", content: "go" }];
    const events: AgentEvent[] = [];

    for await (const event of runAgent({
      provider,
      model: "test-model",
      tools: [],
      messages,
      context: { root: process.cwd() },
      permissions: nonInteractive,
      contextBudget: false,
    })) {
      events.push(event);
    }

    expect(messages[1]).toEqual({
      role: "assistant",
      content: "answer",
      providerData,
    });
    const done = events.find((event) => event.type === "assistant-done");
    expect(done?.type === "assistant-done" ? done.providerData : null).toEqual(
      providerData,
    );
  });
});

describe("read_file", () => {
  it("rejects paths outside the workspace root", async () => {
    await expect(
      readFileTool.execute({ path: "../outside.txt" }, { root: process.cwd() }),
    ).rejects.toThrow(/outside the workspace/);
  });

  it("returns numbered lines for a real file", async () => {
    const result = await readFileTool.execute(
      { path: "package.json", limit: 3 },
      { root: process.cwd() },
    );
    expect(result.content).toMatch(/^\s*1 \| \{/);
  });
});

const dangerSchema = z.object({ value: z.string() });

function makeDangerTool(onExecute: () => void): Tool<typeof dangerSchema> {
  return {
    name: "danger",
    description: "Dangerous tool.",
    inputSchema: dangerSchema,
    capabilities: ["write"],
    summarize(input) {
      return `danger ${input.value}`;
    },
    preview(input) {
      return { kind: "diff", path: "a.txt", before: "", after: input.value };
    },
    async execute() {
      onExecute();
      return { content: "done" };
    },
  };
}

class ApprovalProvider implements Provider {
  private calls = 0;

  async *stream(_request: ChatRequest): AsyncIterable<ProviderEvent> {
    this.calls += 1;

    if (this.calls === 1) {
      yield {
        type: "done",
        message: {
          content: "",
          toolCalls: [
            { id: "call_d", name: "danger", arguments: '{"value":"x"}' },
          ],
        },
        finishReason: "tool_calls",
      };
      return;
    }

    yield {
      type: "done",
      message: { content: "Understood.", toolCalls: [] },
      finishReason: "stop",
    };
  }
}

/** Calls the same gated tool twice before answering. */
class TwoCallProvider implements Provider {
  private calls = 0;

  async *stream(_request: ChatRequest): AsyncIterable<ProviderEvent> {
    this.calls += 1;
    if (this.calls <= 2) {
      yield {
        type: "done",
        message: {
          content: "",
          toolCalls: [
            {
              id: `call_${this.calls}`,
              name: "danger",
              arguments: '{"value":"x"}',
            },
          ],
        },
        finishReason: "tool_calls",
      };
      return;
    }

    yield {
      type: "done",
      message: { content: "Finished.", toolCalls: [] },
      finishReason: "stop",
    };
  }
}

class ContextLimitProvider implements Provider {
  mainCalls = 0;

  async *stream(request: ChatRequest): AsyncIterable<ProviderEvent> {
    const system = request.messages[0];
    const isSummary =
      system?.role === "system" &&
      system.content.includes("compress the transcript");

    if (isSummary) {
      const summary = "- goal: finish the test\n- state: mid-way";
      yield { type: "text", delta: summary };
      yield {
        type: "done",
        message: { content: summary, toolCalls: [] },
        finishReason: "stop",
      };
      return;
    }

    this.mainCalls += 1;
    if (this.mainCalls === 1) {
      throw new Error("This model's maximum context length is 8000 tokens.");
    }

    yield { type: "text", delta: "Recovered." };
    yield {
      type: "done",
      message: { content: "Recovered.", toolCalls: [] },
      finishReason: "stop",
    };
  }
}

class ReasoningProvider implements Provider {
  readonly requests: ChatRequest[] = [];

  async *stream(request: ChatRequest): AsyncIterable<ProviderEvent> {
    this.requests.push(request);
    yield { type: "reasoning", delta: "secret reasoning" };
    yield { type: "text", delta: "done" };
    yield {
      type: "done",
      message: { content: "done", toolCalls: [] },
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 42 },
    };
  }
}

describe("reasoning", () => {
  it("streams reasoning without adding it to the conversation", async () => {
    const messages: Message[] = [{ role: "user", content: "go" }];
    const provider = new ReasoningProvider();
    const events: AgentEvent[] = [];

    for await (const event of runAgent({
      provider,
      model: "test-model",
      tools: [],
      messages,
      context: { root: process.cwd() },
      permissions: nonInteractive,
      contextBudget: false,
    })) {
      events.push(event);
    }

    const reasoning = events.filter(
      (event) => event.type === "reasoning-delta",
    );
    expect(reasoning).toHaveLength(1);

    // The history must not contain the reasoning text: DeepSeek rejects it
    // being sent back, and it is not part of the conversation.
    expect(
      messages.every((message) => !message.content.includes("secret")),
    ).toBe(true);
    expect(messages.at(-1)).toMatchObject({
      role: "assistant",
      content: "done",
    });

    const done = events.find((event) => event.type === "assistant-done");
    expect(done?.type === "assistant-done" ? done.usage?.reasoningTokens : 0).toBe(42);
  });
});

describe("context budget", () => {
  it("compacts and retries when the real window is smaller than assumed", async () => {
    const messages: Message[] = [
      { role: "system", content: "You are a test agent." },
      { role: "user", content: "goal" },
    ];
    for (let index = 0; index < 30; index += 1) {
      messages.push({ role: "user", content: "u".repeat(1000) });
      messages.push({ role: "assistant", content: "a".repeat(1000) });
    }
    const originalLength = messages.length;
    const provider = new ContextLimitProvider();
    const events: AgentEvent[] = [];

    for await (const event of runAgent({
      provider,
      model: "test-model",
      tools: [],
      messages,
      context: { root: process.cwd() },
      permissions: nonInteractive,
    })) {
      events.push(event);
    }

    expect(provider.mainCalls).toBe(2);
    expect(
      events.some(
        (event) =>
          event.type === "assistant-done" && event.content === "Recovered.",
      ),
    ).toBe(true);
    expect(events.some((event) => event.type === "context-compacted")).toBe(true);
    expect(messages.length).toBeLessThan(originalLength);
    expect(messages[1]?.content).toContain("Earlier conversation summary");
  });

  it("can be turned off per run", async () => {
    const messages: Message[] = [
      { role: "user", content: "u".repeat(20_000) },
    ];
    const events: AgentEvent[] = [];
    const answer: Provider = {
      async *stream() {
        yield { type: "text", delta: "ok" };
        yield {
          type: "done",
          message: { content: "ok", toolCalls: [] },
          finishReason: "stop",
        };
      },
    };

    for await (const event of runAgent({
      provider: answer,
      model: "test-model",
      tools: [],
      messages,
      context: { root: process.cwd() },
      permissions: nonInteractive,
      contextBudget: false,
    })) {
      events.push(event);
    }

    expect(events.some((event) => event.type === "context-compacted")).toBe(
      false,
    );
  });
});

describe("tool approval", () => {
  it("asks before running approval-gated tools and blocks denials", async () => {
    let executed = false;
    const messages: Message[] = [{ role: "user", content: "go" }];
    const approvals: ApprovalRequest[] = [];
    const events: AgentEvent[] = [];
    const permissions = new PermissionPolicy({
      preset: "ask",
      interactive: true,
    });

    for await (const event of runAgent({
      provider: new ApprovalProvider(),
      model: "test-model",
      tools: [
        makeDangerTool(() => {
          executed = true;
        }),
      ],
      messages,
      context: { root: process.cwd() },
      permissions,
      approve: (request) => {
        approvals.push(request);
        return "deny";
      },
    })) {
      events.push(event);
    }

    expect(executed).toBe(false);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.toolName).toBe("danger");
    expect(approvals[0]?.summary).toBe("danger x");
    expect(approvals[0]?.preview).toEqual({
      kind: "diff",
      path: "a.txt",
      before: "",
      after: "x",
    });

    const end = events.find((event) => event.type === "tool-end");
    expect(end?.type === "tool-end" ? end.denied : false).toBe(true);
    expect(end?.type === "tool-end" ? end.result.isError : false).toBe(true);

    expect(messages).toHaveLength(4);
    expect(messages[2]?.content).toMatch(/Permission denied/);
    expect(messages[3]).toMatchObject({
      role: "assistant",
      content: "Understood.",
    });
  });

  it("runs the tool when approved", async () => {
    let executed = false;
    const messages: Message[] = [{ role: "user", content: "go" }];
    const events: AgentEvent[] = [];
    const permissions = new PermissionPolicy({
      preset: "ask",
      interactive: true,
    });

    for await (const event of runAgent({
      provider: new ApprovalProvider(),
      model: "test-model",
      tools: [
        makeDangerTool(() => {
          executed = true;
        }),
      ],
      messages,
      context: { root: process.cwd() },
      permissions,
      approve: () => "allow",
    })) {
      events.push(event);
    }

    expect(executed).toBe(true);
    const end = events.find((event) => event.type === "tool-end");
    expect(end?.type === "tool-end" ? end.denied : true).toBe(false);
    expect(end?.type === "tool-end" ? end.result.content : "").toBe("done");
  });

  it("fails closed when the surface has no approver", async () => {
    let executed = false;
    const messages: Message[] = [{ role: "user", content: "go" }];
    const events: AgentEvent[] = [];
    const permissions = new PermissionPolicy({
      preset: "ask",
      interactive: false,
    });

    for await (const event of runAgent({
      provider: new ApprovalProvider(),
      model: "test-model",
      tools: [
        makeDangerTool(() => {
          executed = true;
        }),
      ],
      messages,
      context: { root: process.cwd() },
      permissions,
    })) {
      events.push(event);
    }

    expect(executed).toBe(false);
    const end = events.find((event) => event.type === "tool-end");
    expect(end?.type === "tool-end" ? end.denied : false).toBe(true);
    expect(messages[2]?.content).toMatch(/no interactive approver/);
  });

  it("plan mode denies without consulting the approver", async () => {
    let executed = false;
    let approvals = 0;
    const messages: Message[] = [{ role: "user", content: "go" }];
    const events: AgentEvent[] = [];
    const permissions = new PermissionPolicy({
      preset: "plan",
      interactive: true,
    });

    for await (const event of runAgent({
      provider: new ApprovalProvider(),
      model: "test-model",
      tools: [
        makeDangerTool(() => {
          executed = true;
        }),
      ],
      messages,
      context: { root: process.cwd() },
      permissions,
      approve: () => {
        approvals += 1;
        return "allow";
      },
    })) {
      events.push(event);
    }

    expect(approvals).toBe(0);
    expect(executed).toBe(false);
    const end = events.find((event) => event.type === "tool-end");
    expect(end?.type === "tool-end" ? end.denied : false).toBe(true);
    expect(messages[2]?.content).toMatch(/plan mode is read-only/);
  });

  it("remembers allow-session for the rest of the process", async () => {
    let executed = 0;
    let approvals = 0;
    const messages: Message[] = [{ role: "user", content: "go" }];
    const permissions = new PermissionPolicy({
      preset: "ask",
      interactive: true,
    });

    for await (const _event of runAgent({
      provider: new TwoCallProvider(),
      model: "test-model",
      tools: [
        makeDangerTool(() => {
          executed += 1;
        }),
      ],
      messages,
      context: { root: process.cwd() },
      permissions,
      approve: () => {
        approvals += 1;
        return "allow-session";
      },
    })) {
      // Drain.
    }

    expect(executed).toBe(2);
    expect(approvals).toBe(1);
    expect(permissions.isSessionAllowed("danger")).toBe(true);
  });
});
