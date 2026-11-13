import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { setImmediate } from "node:timers/promises";
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
      if (results.length === 0) yield { type: "text", delta: "Before the approvals.\n" };
      yield {
        type: "done",
        message: results.length === 0
          ? { content: "Before the approvals.\n", toolCalls: calls }
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
    const frame = frames.find((output) => output.includes("Waiting for approval · Create file") && output.includes(`${file} · +40`));
    expect(frame).toBeDefined();
    return frame!;
  });
  try {
    await waitForText("Ask Cooper to inspect or change the project");
    stdin.write("Write two files");
    await waitForText("Write two files");
    stdin.write("\r");
    const first = await approvalFor("first.txt");
    const press = async (key: string, expected: string) => {
      const start = frames.length;
      stdin.write(key);
      await vi.waitFor(() => expect(frames.slice(start).join("")).toContain(expected));
    };
    expect(first).toContain("Page 1/3");
    await press("\x1b[C", "Page 2/3");
    await press("\x1b[C", "first.txt line 39");
    stdout.rows = 20;
    const resizedAt = frames.length;
    stdout.emit("resize");
    await vi.waitFor(() => expect(frames.slice(resizedAt).join("")).toContain("Page 3/4"));
    await press("\x1b[C", "first.txt line 39");
    stdin.write("\r");
    await setImmediate();
    expect(fs.existsSync(path.join(root, "first.txt"))).toBe(false);
    await press("a", "Confirm tool permission");
    expect(fs.existsSync(path.join(root, "first.txt"))).toBe(false);
    await press("\x1b", "Page 4/4");
    stdin.write("y");
    const second = await approvalFor("second.txt");
    stdin.write("n");
    await waitForText("Batch complete.");
    expect(fs.existsSync(path.join(root, "first.txt"))).toBe(true);
    expect(fs.existsSync(path.join(root, "second.txt"))).toBe(false);
    expect(requestResults).toEqual([[], ["call_0", "call_1"]]);
    const history = stripVTControlCharacters(frames.join(""));
    expect(history.match(/Before the approvals\./g)).toHaveLength(1);
    expect(history.match(/Allowed once · Write first\.txt/g)).toHaveLength(1);
    expect(history.match(/Denied · Write second\.txt/g)).toHaveLength(1);
    expect(history).not.toContain("⊘ write_file");

    for (const [frame, rows] of [[first, 24], [second, 20]] as const) {
      const lines = stripVTControlCharacters(frame).split("\n");
      const start = lines.findIndex((line) => line.includes("╭"));
      const end = lines.findIndex((line, index) => index > start && line.includes("╰"));
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(start);
      const panel = lines.slice(start, end + 1);
      expect(panel.length).toBeLessThan(rows);
      expect(panel.join("\n")).toContain("n/Esc Deny");
    }
  } finally {
    app.unmount();
    await app.waitUntilExit();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
