import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SessionWriter,
  createSession,
  isRuntimeNotice,
  loadSession,
  type AssistantMessage,
  type ChatRequest,
  type LoadedInstructions,
  type Provider,
  type ProviderEvent,
} from "@cooper/core";
import type { Config } from "../src/config.js";
import { runHeadless } from "../src/headless.js";

const config: Config = {
  protocol: "openai-chat",
  apiKey: "test-key",
  baseURL: "https://api.openai.com/v1",
  model: "test-model",
  maxOutputTokens: 64_000,
  context: { window: 200_000 },
  contextWindowAssumed: false,
  showReasoning: false,
  defaultMode: undefined,
  sources: {},
  settingsWarnings: [],
  settingsFile: null,
};

const noInstructions: LoadedInstructions = { text: "", sources: [] };

class ScriptedProvider implements Provider {
  private index = 0;

  constructor(private readonly responses: AssistantMessage[]) {}

  async *stream(): AsyncIterable<ProviderEvent> {
    const response = this.responses[this.index];
    this.index += 1;
    if (response === undefined) {
      throw new Error("ScriptedProvider ran out of responses");
    }
    if (response.content.length > 0) {
      yield { type: "text", delta: response.content };
    }
    yield { type: "done", message: response, finishReason: null };
  }
}

/** A provider that reports text only in the completion, never as deltas. */
class NoDeltaProvider implements Provider {
  async *stream(): AsyncIterable<ProviderEvent> {
    yield {
      type: "done",
      message: { content: "from completion", toolCalls: [] },
      finishReason: null,
    };
  }
}

class ReasoningProvider implements Provider {
  async *stream(): AsyncIterable<ProviderEvent> {
    yield { type: "reasoning", delta: "let me think\n" };
    yield { type: "text", delta: "answer" };
    yield {
      type: "done",
      message: { content: "answer", toolCalls: [] },
      finishReason: "stop",
    };
  }
}

class FailingProvider implements Provider {
  async *stream(): AsyncIterable<ProviderEvent> {
    throw new Error("boom");
  }
}

class CapturingProvider implements Provider {
  readonly requests: ChatRequest[] = [];

  async *stream(request: ChatRequest): AsyncIterable<ProviderEvent> {
    this.requests.push(request);
    yield {
      type: "done",
      message: { content: "ok", toolCalls: [] },
      finishReason: "stop",
    };
  }
}

function collector() {
  let text = "";
  return {
    write(chunk: string) {
      text += chunk;
      return true;
    },
    get text() {
      return text;
    },
  };
}

const workspaces: string[] = [];

async function makeWorkspace(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cooper-headless-"));
  workspaces.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    workspaces.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

const writeCall: AssistantMessage = {
  content: "",
  toolCalls: [
    {
      id: "call_1",
      name: "write_file",
      arguments: JSON.stringify({ path: "hello.txt", content: "hi" }),
    },
  ],
};

describe("runHeadless", () => {
  it("streams assistant text to stdout and exits 0", async () => {
    const root = await makeWorkspace();
    const out = collector();
    const err = collector();

    const code = await runHeadless({
      config,
      root,
      instructions: noInstructions,
      showReasoning: false,
      mode: "auto",
      prompt: "hi",
      provider: new ScriptedProvider([{ content: "Hello\nworld", toolCalls: [] }]),
      out,
      err,
    });

    expect(code).toBe(0);
    expect(out.text).toBe("Hello\nworld\n");
    expect(err.text).toBe("");
  });

  it("prints completion-only text that arrived without deltas", async () => {
    const root = await makeWorkspace();
    const out = collector();

    const code = await runHeadless({
      config,
      root,
      instructions: noInstructions,
      showReasoning: false,
      mode: "auto",
      prompt: "hi",
      provider: new NoDeltaProvider(),
      out,
      err: collector(),
    });

    expect(code).toBe(0);
    expect(out.text).toBe("from completion\n");
  });

  it("executes approval-gated tools in auto mode", async () => {
    const root = await makeWorkspace();
    const out = collector();
    const err = collector();

    const code = await runHeadless({
      config,
      root,
      instructions: noInstructions,
      showReasoning: false,
      mode: "auto",
      prompt: "write it",
      provider: new ScriptedProvider([
        writeCall,
        { content: "Done.", toolCalls: [] },
      ]),
      out,
      err,
    });

    expect(code).toBe(0);
    expect(await readFile(path.join(root, "hello.txt"), "utf8")).toBe("hi");
    expect(err.text).toContain("→ write_file");
    expect(err.text).toContain("✓");
    expect(out.text).toBe("Done.\n");
  });

  it("denies approval-gated tools in ask mode and keeps going", async () => {
    const root = await makeWorkspace();
    const out = collector();
    const err = collector();

    const code = await runHeadless({
      config,
      root,
      instructions: noInstructions,
      showReasoning: false,
      mode: "ask",
      prompt: "write it",
      provider: new ScriptedProvider([
        writeCall,
        { content: "I could not write the file.", toolCalls: [] },
      ]),
      out,
      err,
    });

    expect(code).toBe(0);
    expect(err.text).toContain("no interactive approver");
    expect(err.text).toContain("⊘");
    expect(out.text).toBe("I could not write the file.\n");
    await expect(readFile(path.join(root, "hello.txt"), "utf8")).rejects.toThrow();
  });

  it("denies approval-gated tools in plan mode", async () => {
    const root = await makeWorkspace();
    const err = collector();

    const code = await runHeadless({
      config,
      root,
      instructions: noInstructions,
      showReasoning: false,
      mode: "plan",
      prompt: "write it",
      provider: new ScriptedProvider([
        writeCall,
        { content: "Plan only.", toolCalls: [] },
      ]),
      out: collector(),
      err,
    });

    expect(code).toBe(0);
    expect(err.text).toContain("plan mode");
    expect(err.text).toContain("⊘");
  });

  it("keeps reasoning out of stdout and shows it on stderr when enabled", async () => {
    const root = await makeWorkspace();
    const out = collector();
    const err = collector();

    const code = await runHeadless({
      config,
      root,
      instructions: noInstructions,
      showReasoning: true,
      mode: "auto",
      prompt: "hi",
      provider: new ReasoningProvider(),
      out,
      err,
    });

    expect(code).toBe(0);
    expect(out.text).toBe("answer\n");
    expect(err.text).toContain("⋯ let me think");
  });

  it("stays silent about reasoning by default", async () => {
    const root = await makeWorkspace();
    const out = collector();
    const err = collector();

    await runHeadless({
      config,
      root,
      instructions: noInstructions,
      showReasoning: false,
      mode: "auto",
      prompt: "hi",
      provider: new ReasoningProvider(),
      out,
      err,
    });

    expect(out.text).toBe("answer\n");
    expect(err.text).not.toContain("let me think");
  });

  it("keeps the system prompt mode-neutral and appends a runtime notice", async () => {
    const root = await makeWorkspace();
    const provider = new CapturingProvider();
    const err = collector();

    const code = await runHeadless({
      config,
      root,
      instructions: noInstructions,
      showReasoning: false,
      mode: "plan",
      prompt: "plan it",
      provider,
      out: collector(),
      err,
      modeNotice: "Saved session was in auto mode; resumed in ask.",
    });

    expect(code).toBe(0);
    expect(err.text).toContain(
      "mode: Saved session was in auto mode; resumed in ask.",
    );

    const messages = provider.requests[0]?.messages ?? [];
    expect(messages[0]?.role).toBe("system");
    expect(messages[0]?.content).not.toContain("You are in plan mode");

    const noticeIndex = messages.findIndex(
      (message) =>
        message.role === "user" && message.runtime === "permission-mode",
    );
    const userIndex = messages.findIndex(
      (message) => message.role === "user" && message.content === "plan it",
    );
    expect(noticeIndex).toBeGreaterThanOrEqual(0);
    expect(noticeIndex).toBeLessThan(userIndex);
    expect(messages[noticeIndex]?.content).toContain('mode="plan"');
  });

  it("saves a headless turn and resumes it in a later run", async () => {
    const root = await makeWorkspace();
    const home = await makeWorkspace();
    const writer = createSession({ cwd: root, model: config.model, home });
    const err = collector();

    const first = await runHeadless({
      config,
      root,
      instructions: noInstructions,
      showReasoning: false,
      mode: "auto",
      prompt: "first",
      provider: new ScriptedProvider([{ content: "one", toolCalls: [] }]),
      out: collector(),
      err,
      session: writer,
    });

    expect(first).toBe(0);
    expect(err.text).toContain(`session ${writer.id}`);

    const saved = loadSession(writer.file);
    // The mode notice is persisted but hidden from the user-facing transcript.
    expect(saved.messages[0]).toMatchObject({
      role: "user",
      runtime: "permission-mode",
    });
    expect(saved.preset).toBe("auto");
    expect(saved.messages.filter((message) => !isRuntimeNotice(message))).toEqual([
      { role: "user", content: "first" },
      { role: "assistant", content: "one" },
    ]);

    const resumedErr = collector();
    const second = await runHeadless({
      config,
      root,
      instructions: noInstructions,
      showReasoning: false,
      mode: "auto",
      prompt: "second",
      provider: new ScriptedProvider([{ content: "two", toolCalls: [] }]),
      out: collector(),
      err: resumedErr,
      session: SessionWriter.from(saved),
      resumed: saved,
    });

    expect(second).toBe(0);
    expect(resumedErr.text).toContain(
      `resumed session ${writer.id} (${saved.messages.length} message(s))`,
    );
    const afterSecond = loadSession(writer.file);
    expect(afterSecond.preset).toBe("auto");
    expect(
      afterSecond.messages.filter((message) => !isRuntimeNotice(message)),
    ).toEqual([
      { role: "user", content: "first" },
      { role: "assistant", content: "one" },
      { role: "user", content: "second" },
      { role: "assistant", content: "two" },
    ]);
  });

  it("returns 1 and reports provider failures", async () => {
    const root = await makeWorkspace();
    const err = collector();

    const code = await runHeadless({
      config,
      root,
      instructions: noInstructions,
      showReasoning: false,
      mode: "auto",
      prompt: "hi",
      provider: new FailingProvider(),
      out: collector(),
      err,
    });

    expect(code).toBe(1);
    expect(err.text).toContain("Error: boom");
  });
});
