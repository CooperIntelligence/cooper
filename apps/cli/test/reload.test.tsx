import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { createBuiltinTools } from "@cooper/core";
import { render } from "ink";
import { expect, it, vi } from "vitest";
import { App } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createProvider } from "../src/provider.js";

it("edits and reloads settings in a running TUI without losing the conversation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cooper-reload-"));
  const home = path.join(root, ".cooper");
  const file = path.join(home, "config.json");
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn() });
  const stdout = Object.assign(new PassThrough(), { columns: 120 });
  const stderr = new PassThrough();
  let output = "";
  stdout.on("data", (chunk) => { output += String(chunk); });

  const oldSettings = {
    protocol: "openai-chat",
    model: "old-model",
    baseURL: "https://old.example/v1",
    apiKey: "old-key",
    context: { customPreference: "keep" },
  };
  const newSettings = {
    ...oldSettings,
    model: "new-model",
    baseURL: "https://new.example/v1",
    apiKey: "new-key",
    mode: "plan",
    showReasoning: false,
    shell: { kind: process.platform === "win32" ? "cmd" : "sh" },
    context: { window: 40_000 },
  };
  let replies = 0;
  const fetch = vi.fn(async (_url: string, _request: RequestInit) => {
    const chunk = { choices: [{ delta: { content: `reply ${++replies}` }, finish_reason: "stop" }] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
      headers: { "Content-Type": "text/event-stream" },
    });
  });
  vi.stubGlobal("fetch", fetch);
  const homedir = vi.spyOn(os, "homedir").mockReturnValue(root);
  let app: ReturnType<typeof render> | undefined;

  const press = async (key: string, expected: string) => {
    const start = output.length;
    stdin.write(key);
    await vi.waitFor(() => expect(output.slice(start)).toContain(expected));
  };

  const enter = async (value: string, expected: string, display = value) => {
    const start = output.length;
    stdin.write(value);
    await vi.waitFor(() => expect(output.slice(start)).toContain(display));
    await press("\r", expected);
  };

  try {
    fs.mkdirSync(home);
    fs.writeFileSync(file, JSON.stringify(oldSettings));
    const config = loadConfig({ showReasoning: true });
    app = render(
      <App
        config={config}
        root={root}
        mode="ask"
        modeSource="default"
        instructions={{ text: "", sources: [] }}
        showReasoningFlag={true}
        provider={createProvider(config)}
        tools={createBuiltinTools(config.shell)}
        mcp={{ sources: [], statuses: [], warnings: [] }}
        session={null}
        resumed={null}
      />,
      { stdin, stdout, stderr, debug: true, patchConsole: false },
    );
    await vi.waitFor(() => expect(stdin.setRawMode).toHaveBeenCalledWith(true));
    const startup = stripVTControlCharacters(output);
    const [title, workspace] = startup.split(/\r?\n/);
    expect(title).toBe("COOPER  old-model");
    expect(workspace).toContain(path.basename(root));
    expect(startup).not.toMatch(/\/help|Context:|Instructions:|MCP:|Session:/);
    await enter("first prompt", "reply 1");

    const original = fs.readFileSync(file, "utf8");
    await enter("/config baseURL", "Config · baseURL");
    await press("\r", "baseURL >");
    await enter("invalid-url", "Config · baseURL  invalid-url");
    await press("\x13", "Could not save configuration");
    expect(fs.readFileSync(file, "utf8")).toBe(original);
    await press("\x1b", "Ask Cooper to inspect or change the project");

    await enter("/config", "Config · model");
    await press("\r", "model >");
    await enter("edited-model", "Config · model  edited-model");
    await press("\x1b[B", "Config · protocol");
    await press("\x1b[B", "Config · baseURL");
    await press("\r", "baseURL >");
    await enter("https://edited.example/v1", "Config · baseURL  https://edited.example/v1");
    await press("\x1b[B", "Config · apiKey");
    await press("\r", "apiKey >");
    await enter("edited-key", "Config · apiKey  set", "**********");
    expect(fs.readFileSync(file, "utf8")).toBe(original);
    await press("\x13", "Configuration saved and applied · edited-model");
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({
      ...oldSettings, model: "edited-model", baseURL: "https://edited.example/v1", apiKey: "edited-key",
    });
    await enter("second prompt", "reply 2");

    fs.writeFileSync(file, JSON.stringify(newSettings));
    await enter("/reload", "Configuration reloaded");
    await enter("/status", "Settings file:");
    expect(output).toContain("Workspace:");
    expect(output).toContain("Instructions: none");
    expect(output).toContain("Session: not saved (--no-session)");
    expect(output).toMatch(/Mode: ask \(default\)/);
    expect(output).toMatch(/showReasoning\s+on\s+flag/);
    expect(output).toMatch(/Context usage \(estimated\): \d+ \/ 40000 tokens/);
    expect(output).toMatch(new RegExp(`shell\\s+${newSettings.shell.kind} `));
    await enter("third prompt", "reply 3");

    fs.writeFileSync(file, '{"apiKey":"broken-secret"', "utf8");
    await enter("/reload", "Still using the previous settings");
    await enter("fourth prompt", "reply 4");

    expect(output).not.toMatch(/old-key|edited-key|new-key|broken-secret/);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "https://old.example/v1/chat/completions",
      "https://edited.example/v1/chat/completions",
      "https://new.example/v1/chat/completions",
      "https://new.example/v1/chat/completions",
    ]);
    const edited = fetch.mock.calls[1]?.[1];
    expect(new Headers(edited?.headers).get("authorization")).toBe("Bearer edited-key");
    expect(JSON.parse(String(edited?.body))).toMatchObject({ model: "edited-model" });
    const request = fetch.mock.calls[3]?.[1];
    expect(new Headers(request?.headers).get("authorization")).toBe("Bearer new-key");
    expect(JSON.parse(String(request?.body))).toMatchObject({
      model: "new-model",
      messages: expect.arrayContaining([
        { role: "user", content: "first prompt" },
        { role: "assistant", content: "reply 1" },
        { role: "user", content: "fourth prompt" },
      ]),
    });
  } finally {
    app?.unmount();
    await app?.waitUntilExit();
    homedir.mockRestore();
    vi.unstubAllGlobals();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
