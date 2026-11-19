import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeSettingsDocument } from "@cooper/host";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DesktopConnection } from "../src/connection.js";

const input = {
  protocol: "openai-chat",
  baseURL: "https://gateway.example/v1",
  model: "desktop-model",
  apiKey: "desktop-secret",
} as const;

let home: string;
let file: string;
let connection: DesktopConnection;

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "cooper-connect-"));
  file = path.join(home, "config.json");
  connection = new DesktopConnection(home);
});

afterEach(() => rm(home, { recursive: true, force: true }));

it("completes a fresh setup and recognizes it on startup", () => {
  const initial = connection.read();
  if (initial.kind !== "incomplete") throw new Error("Expected first-run setup");
  const { document, values } = connection.prepare(initial.revision, input);
  writeSettingsDocument(document, values);

  const status = new DesktopConnection(home).read();
  expect(status).toMatchObject({
    kind: "ready", hasKey: true,
    fields: { protocol: input.protocol, baseURL: input.baseURL, model: input.model },
  });
  expect(JSON.stringify(status)).not.toContain(input.apiKey);
});

it("keeps another client's settings and reuses the existing key only for the original endpoint", async () => {
  await writeFile(file, JSON.stringify({
    ...input, mode: "plan", context: { compact: false }, showReasoning: true,
  }));
  const status = connection.read();
  if (status.kind !== "ready") throw new Error("Expected valid configuration");
  const { apiKey, ...fields } = input;

  const { values } = connection.prepare(status.revision, { ...fields, model: "new-model" });
  expect(values).toMatchObject({ model: "new-model", apiKey, mode: "plan", context: { compact: false }, showReasoning: true });
  expect(() => connection.prepare(status.revision, { ...fields, baseURL: "https://other.example/v1" }))
    .toThrow(/API key for this protocol and address/);
  expect(() => connection.prepare(status.revision, { ...fields, protocol: "openai-responses" }))
    .toThrow(/API key for this protocol and address/);
});

it("leaves a malformed file intact and recognizes a subsequent repair", async () => {
  const malformed = '{ "apiKey": "desktop-secret"';
  await writeFile(file, malformed);
  const status = connection.read();
  expect(status).toMatchObject({ kind: "invalid", file, message: expect.stringMatching(/Invalid JSON/) });
  expect(JSON.stringify(status)).not.toContain(input.apiKey);
  expect(() => connection.prepare(undefined, input)).toThrow(/Reopen/);
  await expect(readFile(file, "utf8")).resolves.toBe(malformed);
  await writeFile(file, JSON.stringify(input));
  expect(connection.read().kind).toBe("ready");
});

it("detects configuration edits made after the form opens", async () => {
  await writeFile(file, JSON.stringify(input));
  const status = connection.read();
  if (status.kind !== "ready") throw new Error("Expected valid configuration");
  const { document, values } = connection.prepare(status.revision, { ...input, model: "new-model" });
  const changed = JSON.stringify({ ...input, mode: "plan" });
  await writeFile(file, changed);
  expect(() => writeSettingsDocument(document, values)).toThrow(/config.json changed/);
  await expect(readFile(file, "utf8")).resolves.toBe(changed);
});
