import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { createBuiltinTools, type Provider, type ToolCall } from "@cooper/core";
import { render, type RenderOptions } from "ink";
import { expect, it, vi } from "vitest";
import { App, tuiRenderOptions } from "../src/app.js";
import { loadConfig } from "../src/config.js";

function call(id: string, name: string, input: object): ToolCall {
  return { id, name, arguments: JSON.stringify(input) };
}

it("renders the approval panel with the repository-root dev JSX transform", () => {
  const tsx = createRequire(import.meta.url).resolve("tsx/cli");
  const env = { ...process.env };
  delete env.TSX_TSCONFIG_PATH;
  const output = execFileSync(process.execPath, [tsx, "--input-type=module", "--eval", `
    import { createElement } from "react";
    import { renderToString } from "ink";
    import { ApprovalPanel } from "./apps/cli/src/approval.js";
    const request = {
      call: { id: "test", name: "write_file", arguments: "{}" },
      toolName: "write_file", summary: "Write sample.txt", input: {}, capabilities: ["write"],
      preview: { kind: "diff", path: "sample.txt", before: "", after: "1\\n", createsFile: true },
    };
    console.log(renderToString(createElement(ApprovalPanel, { request, onDecision() {}, onInterrupt() {} })));
  `], {
    cwd: new URL("../../../", import.meta.url),
    env,
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true,
  });
  expect(output).toContain("Waiting for approval · Create file");
  expect(output).toContain("sample.txt · +1");
}, 20_000);

it("shows the full web request and offers single approval only", async () => {
  const app = fixture(() => [call("fetch", "web_fetch", { url: "https://example.com/docs?version=22" })]);
  try {
    await app.submit("Read the docs", "GET https://example.com/docs?version=22");
    expect(app.history()).toContain("y Allow once");
    expect(app.history()).not.toContain("Allow this tool until exit");
    await app.press("n", "Denied");
  } finally {
    await app.close();
  }
});

function fixture(callsFor: (prompt: string) => ToolCall[], renderOptions: RenderOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cooper-approval-"));
  const home = vi.spyOn(os, "homedir").mockReturnValue(root);
  const configFile = path.join(root, ".cooper", "config.json");
  fs.mkdirSync(path.dirname(configFile));
  const settings = { protocol: "openai-chat", model: "test", baseURL: "https://test.invalid/v1", apiKey: "test" };
  const writeConfig = (extra = {}) => fs.writeFileSync(configFile, JSON.stringify({ ...settings, ...extra }));
  writeConfig();
  const config = loadConfig();
  const provider: Provider = {
    async *stream({ messages }) {
      const prompt = messages.findLast((message) => message.role === "user" && message.runtime === undefined)?.content ?? "";
      const calls = messages.at(-1)?.role === "tool" ? [] : callsFor(prompt);
      yield {
        type: "done",
        message: { content: calls.length === 0 ? `Finished ${prompt}` : "", toolCalls: calls },
        finishReason: calls.length === 0 ? "stop" : "tool_calls",
      };
    },
  };
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn() });
  const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 24 });
  let output = "";
  stdout.on("data", (chunk) => { output += String(chunk); });
  const app = render(
    <App config={config} root={root} mode="ask" modeSource="default"
      instructions={{ text: "", sources: [] }} showReasoningFlag={false}
      provider={provider} tools={createBuiltinTools(config.shell)}
      mcp={{ sources: [], statuses: [], warnings: [] }} session={null} resumed={null}
    />,
    { stdin, stdout, interactive: true, patchConsole: false, exitOnCtrlC: false, ...renderOptions },
  );
  const press = async (key: string, expected: string) => {
    const start = output.length;
    stdin.write(key);
    return vi.waitFor(() => {
      const update = stripVTControlCharacters(output.slice(start));
      expect(update).toContain(expected);
      return update;
    });
  };
  return {
    root, writeConfig, press,
    history: () => stripVTControlCharacters(output),
    async submit(text: string, expected: string) {
      await vi.waitFor(() => expect(output).toContain("Ask Cooper to inspect or change the project"));
      await press(text, text);
      await press("\r", expected);
    },
    async close() {
      app.unmount();
      await app.waitUntilExit();
      home.mockRestore();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

it.runIf(process.platform === "win32")("updates the typed character without repainting the Windows prompt", async () => {
  const app = fixture(() => [], tuiRenderOptions);
  try {
    await app.submit("Show a reply", "Finished Show a reply");
    await app.press("x", "x");
    const update = await app.press("j", "j");
    expect(update).not.toContain("ask >");
    expect(update).not.toContain("Finished Show a reply");
  } finally {
    await app.close();
  }
});

it("discards an outdated approval and its pending process grant", async () => {
  const fixtureApp = fixture(() => [
    call("call_first", "edit_file", { path: "first.txt", old_string: "old", new_string: "new" }),
    call("call_second", "edit_file", { path: "second.txt", old_string: "old", new_string: "new" }),
  ]);
  const { root, press, submit, history } = fixtureApp;
  const first = path.join(root, "first.txt");
  const second = path.join(root, "second.txt");
  fs.writeFileSync(first, "old at the top\n");
  fs.writeFileSync(second, "old\n");
  try {
    await submit("Edit both files", "first.txt · +1 −1");
    await press("a", "Confirm tool permission");
    fs.writeFileSync(first, "new heading\nold at a different location\n");
    await press("y", "File changed. Review the updated preview.");
    expect(fs.readFileSync(first, "utf8")).toBe("new heading\nold at a different location\n");
    expect(history()).toContain("+new at a different location");
    expect(history()).not.toContain("Allowed until exit ·");
    await press("y", "second.txt · +1 −1");
    expect(fs.readFileSync(first, "utf8")).toBe("new heading\nnew at a different location\n");
    await press("\x1b", "Finished Edit both files");
    expect(fs.readFileSync(second, "utf8")).toBe("old\n");
  } finally {
    await fixtureApp.close();
  }
});

it("asks again when a command's working directory changes during approval", async () => {
  const fixtureApp = fixture(() => [
    call("call_command", "run_command", { command: "echo approved > marker.txt", cwd: "linked" }),
  ]);
  const { root, press, submit, history } = fixtureApp;
  const first = path.join(root, "first");
  const second = path.join(root, "second");
  const linked = path.join(root, "linked");
  const linkType = process.platform === "win32" ? "junction" : "dir";
  try {
    fs.mkdirSync(first);
    fs.mkdirSync(second);
    fs.symlinkSync(first, linked, linkType);
    await submit("Run in linked directory", "Waiting for approval · Run command");
    expect(history()).toContain("first");
    await press("a", "Confirm tool permission");
    fs.unlinkSync(linked);
    fs.symlinkSync(second, linked, linkType);
    await press("y", "Working directory changed. Review the updated preview.");
    expect(history()).toContain("second");
    expect(history()).not.toContain("Allowed until exit ·");
    expect(fs.existsSync(path.join(first, "marker.txt"))).toBe(false);
    expect(fs.existsSync(path.join(second, "marker.txt"))).toBe(false);

    await press("y", "Finished Run in linked directory");
    expect(fs.existsSync(path.join(first, "marker.txt"))).toBe(false);
    expect(fs.existsSync(path.join(second, "marker.txt"))).toBe(true);
    await submit("Run another command", "Waiting for approval · Run command");
    await press("n", "Finished Run another command");
  } finally {
    await fixtureApp.close();
  }
});

it("retains tool grants on reload and revokes only the command grant when the shell changes", async () => {
  const fixtureApp = fixture((prompt) => [prompt.startsWith("write")
    ? call(prompt, "write_file", { path: `${prompt}.txt`, content: "written\n" })
    : call(prompt, "run_command", { command: "echo cooper-approval" })]);
  const { root, press, submit, writeConfig } = fixtureApp;
  try {
    await submit("write-first", "Waiting for approval · Create file");
    await press("a", "Confirm tool permission");
    await press("y", "Finished write-first");
    await submit("command-first", "Waiting for approval · Run command");
    await press("a", "Confirm tool permission");
    await press("y", "Finished command-first");
    await submit("/clear", "COOPER");
    await submit("/reload", "Configuration reloaded");
    await submit("command-second", "Finished command-second");
    expect(fixtureApp.history()).toContain("process grant");

    writeConfig({ shell: { kind: process.platform === "win32" ? "cmd" : "sh" } });
    await submit("/reload", "Configuration reloaded");
    await submit("command-third", "Waiting for approval · Run command");
    await press("n", "Finished command-third");
    await submit("write-second", "Finished write-second");
    expect(fs.readFileSync(path.join(root, "write-second.txt"), "utf8")).toBe("written\n");
  } finally {
    await fixtureApp.close();
  }
});

it("shows a long command through its redirection at the end", async () => {
  const command = Array.from({ length: 36 }, (_, index) => `echo part-${index}`).join("\n") + "\necho tail | more > result.txt";
  const fixtureApp = fixture(() => [call("call_long", "run_command", { command })]);
  try {
    await fixtureApp.submit("Long command", "Page 1/3");
    expect(fixtureApp.history()).toContain("cwd:");
    await fixtureApp.press("\x1b[C", "Page 2/3");
    await fixtureApp.press("\x1b[C", "echo tail | more > result.txt");
    await fixtureApp.press("a", "Confirm tool permission");
    await fixtureApp.press("n", "Finished Long command");
    expect(fs.existsSync(path.join(fixtureApp.root, "result.txt"))).toBe(false);
  } finally {
    await fixtureApp.close();
  }
});
