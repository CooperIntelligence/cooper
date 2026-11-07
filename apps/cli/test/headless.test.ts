import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AssistantMessage,
  Provider,
  ProviderEvent,
} from "@cooper/core";
import type { Config } from "../src/config.js";
import { runHeadless } from "../src/headless.js";

const config: Config = { apiKey: "test-key", baseURL: undefined, model: "test-model" };

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

class FailingProvider implements Provider {
  async *stream(): AsyncIterable<ProviderEvent> {
    throw new Error("boom");
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

  it("returns 1 and reports provider failures", async () => {
    const root = await makeWorkspace();
    const err = collector();

    const code = await runHeadless({
      config,
      root,
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
