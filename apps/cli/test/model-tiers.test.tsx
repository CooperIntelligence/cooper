import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import {
  createSession, loadSession, SessionWriter, type Message, type Provider,
} from "@cooper/core";
import { render } from "ink";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app.js";
import { parseArgs } from "../src/args.js";
import { describeModel, resolveConfig, selectModelTier } from "@cooper/host";
import { runHeadless } from "../src/headless.js";
import { compactForModel, modelBudget } from "@cooper/host";
import { createProvider } from "@cooper/host";
import { parseSettings } from "@cooper/host";

const settings = {
  protocol: "openai-chat", model: "ash", baseURL: "https://gateway.example/v1", apiKey: "key",
  context: { window: 1_000_000 },
  modelTiers: {
    sera: { model: "large", reasoningEffort: "high", maxOutputTokens: 16_000 },
    cher: { model: "small", displayName: "Fast coder", reasoningEffort: "low", contextWindow: 256_000, maxOutputTokens: 16_000 },
  },
};
const parse = (input: Record<string, unknown> = settings) => resolveConfig(parseSettings(input, "config.json"));
const instructions = { text: "", sources: [] };
const noTools: [] = [];

afterEach(() => vi.unstubAllGlobals());

it("resolves saved, configured, implicit, and missing tier choices", () => {
  const config = parse();
  expect(config.model).toBe("small");
  expect(config.modelSelection?.inputLimit).toBe(220_446);
  expect(describeModel(config)).toBe("Cherubina · Fast coder (small)");
  expect(selectModelTier(config, "sera").model).toBe("large");
  expect(describeModel(selectModelTier(config, "thr"))).toBe("Thronia (fallback: ash)");
  expect(selectModelTier(config, null).modelSelection?.tier).toBeNull();
  expect(parse({ ...settings, defaultTier: "thr" }).model).toBe("ash");
  expect(parse({ ...settings, modelTiers: { sera: settings.modelTiers.sera } }).model).toBe("ash");
  expect(parse({ ...settings, modelTiers: {} }).modelSelection?.tier).toBeNull();
  expect(parseArgs(["--tier=sera", "-p", "test"]).tier).toBe("sera");
  expect(parseArgs(["--tier", "thr", "-p", "test"]).tier).toBe("thr");
  expect(() => parseArgs(["--tier", "unknown"])).toThrow("Use sera, cher, or thr");
});

it("enforces the window floor for tiers and fallback while preserving single-model support", () => {
  expect(() => parse({ ...settings, context: { window: 255_999 } })).toThrow(/255999.*256000/);
  expect(() => parse({ ...settings, modelTiers: { cher: { model: "m", contextWindow: 200_000 } } }))
    .toThrow(/modelTiers.cher.contextWindow.*256000/);
  expect(() => parse({ ...settings, modelTiers: { cher: { model: "m", contextWindow: 256_000, maxOutputTokens: 256_000 } } }))
    .toThrow(/maxOutputTokens.*less than/);
  expect(() => parse({ ...settings, modelTiers: { thrr: {} } })).toThrow(/modelTiers/);
  expect(() => parse({ ...settings, modelTiers: { cher: {} } })).toThrow(/modelTiers.cher.model/);
  expect(() => parse({ ...settings, modelTiers: { cher: { model: "m", apiKey: "override" } } })).toThrow(/modelTiers.cher/);
  const legacy = parse({ ...settings, modelTiers: undefined, context: undefined });
  expect(legacy.context.window).toBe(200_000);
  expect(() => selectModelTier(legacy, "thr")).toThrow(/200000.*256000/);
  const inferred = parse({ ...settings, model: "gemini-test", context: undefined, modelTiers: { sera: { model: "grok-test" } } });
  expect(selectModelTier(inferred, "sera").context.window).toBe(256_000);
});

describe("tier wire parameters", () => {
  it.each([
    ["openai-chat", { reasoning_effort: "low", max_completion_tokens: 16_000 }, {}],
    ["openai-responses", { reasoning: { summary: "auto", effort: "low" }, max_output_tokens: 16_000 }, { reasoning: { summary: "auto" } }],
    ["anthropic-messages", { output_config: { effort: "low" }, max_tokens: 16_000 }, { max_tokens: 64_000 }],
  ] as const)("sends model settings on %s and isolates a different summary model", async (protocol, expected, summary) => {
    const config = parse({ ...settings, protocol, showReasoning: true });
    const fetch = vi.fn(async (_url: string, request: RequestInit) =>
      new Response(JSON.stringify({ error: { message: "Unsupported request parameter", param: "test" } }), {
        status: 400, headers: { "Content-Type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetch);
    const provider = createProvider(config);
    for (const model of [config.model, "summary-model"]) {
      await expect(async () => {
        for await (const _event of provider.stream({ model, messages: [{ role: "user", content: "test" }], tools: [] })) {
          // Consume the stream to send the request.
        }
      }).rejects.toThrow("Unsupported request parameter");
    }
    const body = (index: number) => JSON.parse(String(fetch.mock.calls[index]?.[1].body));
    expect(body(0)).toMatchObject({ model: "small", ...expected });
    expect(body(1)).toMatchObject({ model: "summary-model", ...summary });
    expect(body(1).reasoning?.effort).toBeUndefined();
    expect(body(1).reasoning_effort).toBeUndefined();
    expect(body(1).output_config).toBeUndefined();
    expect(body(1).max_completion_tokens).toBeUndefined();
  });
});

const history: Message[] = [
  { role: "user", content: "a".repeat(540_000) },
  { role: "assistant", content: "Prior work" },
  { role: "user", content: "b".repeat(540_000) },
  { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "read_file", arguments: "{}" }] },
  { role: "tool", toolCallId: "call-1", content: "source text" },
  { role: "assistant", content: "Last visible reply" },
];

it("keeps the final visible group on an irreducible transition", async () => {
  const config = parse();
  const messages: Message[] = [
    { role: "user", content: "x".repeat(1_080_000) },
    { role: "user", content: "mode notice", runtime: "permission-mode" },
  ];
  const provider: Provider = { async *stream() { throw new Error("summary unavailable"); } };
  const budget = modelBudget(config, messages, noTools, provider);
  await expect(compactForModel(config, provider, messages, budget, new AbortController().signal))
    .rejects.toThrow("Context exceeds");
  expect(messages[0]?.content).toHaveLength(1_080_000);
});

it("recovers the last complete tier and transcript after an interrupted checkpoint append", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cooper-model-checkpoint-"));
  try {
    const small = parse().modelSelection!;
    const large = selectModelTier(parse(), "sera").modelSelection!;
    const session = createSession({ cwd: root, model: large.model, home: root });
    expect(session.appendModelSelection(large)).toBeNull();
    expect(session.appendMessage({ role: "user", content: "Before" })).toBeNull();
    fs.appendFileSync(session.file, '{"type":"checkpoint","action":"model-switch","messages":[');
    const loaded = loadSession(session.file);
    expect(loaded.modelSelection?.tier).toBe("sera");
    expect(loaded.messages).toEqual([{ role: "user", content: "Before" }]);
    const writer = SessionWriter.from(loaded);
    expect(writer.appendCheckpoint("model-switch", [{ role: "user", content: "After" }], undefined, small)).toBeNull();
    expect(loadSession(session.file)).toMatchObject({
      modelSelection: { tier: "cher" }, messages: [{ role: "user", content: "After" }],
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("headless declines a 300K resume into a 256K tier before changing the session", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cooper-model-headless-"));
  try {
    const large = selectModelTier(parse(), "sera");
    const session = createSession({ cwd: root, model: large.model, home: root });
    session.appendModelSelection(large.modelSelection!);
    for (const message of history) session.appendMessage(message);
    const resumed = loadSession(session.file);
    const original = fs.readFileSync(session.file, "utf8");
    const stream = vi.fn<Provider["stream"]>();
    let stderr = "";
    const out = { write: vi.fn() };
    const code = await runHeadless({
      config: parse(), root, prompt: "Continue", mode: "plan", provider: { stream },
      instructions, tools: noTools, session, resumed, showReasoning: false, out,
      err: { write: (chunk) => { stderr += chunk; } },
    });
    expect(code).toBe(1);
    expect(stderr).toContain("220,446 input tokens");
    expect(stderr).toContain("approve compaction");
    expect(stream).not.toHaveBeenCalled();
    expect(out.write).not.toHaveBeenCalled();
    expect(fs.readFileSync(session.file, "utf8")).toBe(original);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("confirms an overflowing TUI switch, then restores the tier and compacted history together", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cooper-model-tui-"));
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn() });
  const stdout = Object.assign(new PassThrough(), { columns: 120 });
  let output = "";
  stdout.on("data", (chunk) => { output += String(chunk); });
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: { message: "No summary" } }), {
    status: 400, headers: { "Content-Type": "application/json" },
  }));
  const config = selectModelTier(parse(), "sera");
  const writer = createSession({ cwd: root, model: config.model, home: root });
  writer.appendModelSelection(config.modelSelection!);
  for (const message of history) writer.appendMessage(message);
  const resumed = loadSession(writer.file);
  const app = render(<App
    root={root} config={config} mode="ask" modeSource="default" instructions={instructions}
    showReasoningFlag={false} provider={createProvider(config)} tools={noTools}
    mcp={{ sources: [], statuses: [], warnings: [] }} session={writer} resumed={resumed}
  />, { stdin, stdout, debug: true, patchConsole: false });
  const press = async (key: string, expected: string) => {
    const start = output.length;
    stdin.write(key);
    await vi.waitFor(() => expect(output.slice(start)).toContain(expected));
  };
  const switchToSmall = async () => {
    await press("/cher", "/cher");
    await press("\r", "Compact and switch");
  };
  try {
    await vi.waitFor(() => expect(stdin.setRawMode).toHaveBeenCalledWith(true));
    const before = fs.readFileSync(writer.file, "utf8");
    await switchToSmall();
    await press("n", "Ask Cooper");
    expect(fs.readFileSync(writer.file, "utf8")).toBe(before);
    await switchToSmall();
    await press("y", "Context compacted for the selected model");
    const loaded = loadSession(writer.file);
    expect(loaded.modelSelection?.tier).toBe("cher");
    expect(loaded.messages.some((message) => message.content === "Last visible reply")).toBe(true);
    const rows = fs.readFileSync(writer.file, "utf8").trimEnd().split("\n").map((row) => JSON.parse(row));
    expect(rows.at(-1)).toMatchObject({ type: "checkpoint", action: "model-switch", modelSelection: { tier: "cher" } });
    const toolGroup = loaded.messages.findIndex((message) => message.role === "assistant" && message.toolCalls?.length);
    expect(toolGroup).toBeGreaterThanOrEqual(0);
    expect(loaded.messages[toolGroup + 1]).toMatchObject({ role: "tool", toolCallId: "call-1" });
    await press("/sera", "/sera");
    await press("\r", "Model · Seraphina");
    expect(loadSession(writer.file).messages).toEqual(loaded.messages);
  } finally {
    app.unmount();
    await app.waitUntilExit();
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 15_000);
