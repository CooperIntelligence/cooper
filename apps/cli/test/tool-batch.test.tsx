import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { createBuiltinTools, type Provider } from "@cooper/core";
import { render } from "ink";
import { expect, it, vi } from "vitest";
import { App } from "../src/app.js";
import { loadConfig } from "../src/config.js";

it("keeps both approvals visible for two writes in one model response", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cooper-tool-batch-"));
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn() });
  const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 24 });
  const frames: string[] = [];
  stdout.on("data", (chunk) => { frames.push(String(chunk)); });
  const calls = ["first.txt", "second.txt"].map((file, index) => ({
    id: `call_${index}`,
    name: "write_file",
    arguments: JSON.stringify({
      path: file,
      content: Array.from({ length: 40 }, (_, line) => `${file} line ${line}\n`).join(""),
    }),
  }));
  const requestResults: string[][] = [];
  const provider: Provider = {
    async *stream({ messages }) {
      const results = messages.flatMap((message) => message.role === "tool" ? [message.toolCallId] : []);
      requestResults.push(results);
      yield {
        type: "done",
        message: results.length === 0
          ? { content: "", toolCalls: calls }
          : { content: "Batch complete.", toolCalls: [] },
        finishReason: results.length === 0 ? "tool_calls" : "stop",
      };
    },
  };
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({
    protocol: "openai-chat", model: "test", baseURL: "https://test.invalid", apiKey: "test",
  }));
  const config = loadConfig({ home: root });
  const app = render(
    <App
      config={config} root={root} mode="ask" modeSource="default"
      instructions={{ text: "", sources: [] }} showReasoningFlag={false}
      provider={provider} tools={createBuiltinTools(config.shell)}
      mcp={{ sources: [], statuses: [], warnings: [] }} session={null} resumed={null}
    />,
    { stdin, stdout, interactive: true, patchConsole: false, exitOnCtrlC: false },
  );

  const waitForText = (value: string) => vi.waitFor(() => expect(frames.join("")).toContain(value));
  const approvalFor = (file: string) => vi.waitFor(() => {
    const frame = frames.find((output) => output.includes("Approve write_file?") && output.includes(`${file} · +40`));
    expect(frame).toBeDefined();
    return frame!;
  });
  try {
    await waitForText("Ask Cooper to inspect or change the project");
    stdin.write("Write two files");
    await waitForText("Write two files");
    stdin.write("\r");
    const first = await approvalFor("first.txt");
    stdin.write("y");
    const second = await approvalFor("second.txt");
    stdin.write("n");
    await waitForText("Batch complete.");
    expect(fs.existsSync(path.join(root, "first.txt"))).toBe(true);
    expect(fs.existsSync(path.join(root, "second.txt"))).toBe(false);
    expect(requestResults).toEqual([[], ["call_0", "call_1"]]);

    for (const frame of [first, second]) {
      const lines = stripVTControlCharacters(frame).split("\n");
      const panel = lines.slice(lines.findIndex((line) => line.includes("Approve write_file?")) - 1);
      expect(panel.length).toBeLessThan(stdout.rows);
      expect(panel.join("\n")).toContain("n / esc deny");
    }
  } finally {
    app.unmount();
    await app.waitUntilExit();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
