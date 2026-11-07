#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import React from "react";
import { render } from "ink";
import { OpenAICompatibleProvider } from "@cooper/core";
import { App } from "./app.js";
import { parseArgs, resolveMode, type ParsedArgs } from "./args.js";
import {
  loadConfig,
  loadEnvFiles,
  type ApprovalMode,
  type Config,
} from "./config.js";
import { runHeadless } from "./headless.js";

const HELP = `Cooper — a terminal coding agent

Usage:
  cooper                          start the interactive TUI
  cooper "fix the failing test"   one-shot; prints the answer to stdout
  cooper -p - < prompt.txt        read the prompt from stdin

Options:
  -m, --mode <mode>   ask (default) | auto | plan
  -C, --cwd <dir>     workspace directory (default: current directory)
  -p, --print [text]  non-interactive; omit text or use "-" for stdin
  -h, --help          show this help

Modes:
  ask    ask before file writes and command execution
  auto   approve every tool call without asking (use with care)
  plan   read-only: inspect files, deny writes and commands

  With -p nobody can answer an approval prompt, so ask denies writes and
  commands; pass --mode auto for unattended edits.

Environment:
  COOPER_API_KEY    API key (falls back to OPENAI_API_KEY)
  COOPER_BASE_URL   OpenAI-compatible endpoint
  COOPER_MODEL      Model name
  COOPER_MODE       Default approval mode (flag wins)

.env is read from the workspace, then from the directory next to Cooper.
`;

function fail(error: unknown): never {
  console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

function resolveRoot(cwd: string | undefined): string {
  const root = path.resolve(process.cwd(), cwd ?? ".");
  let stat: fs.Stats;
  try {
    stat = fs.statSync(root);
  } catch {
    throw new Error(`Workspace directory not found: ${root}`);
  }
  if (!stat.isDirectory()) throw new Error(`Not a directory: ${root}`);
  return root;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    process.stderr.write("Reading prompt from stdin (ctrl+d to finish)…\n");
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  let args: ParsedArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    fail(error);
  }

  if (args.help) {
    console.log(HELP);
    return;
  }

  let root: string;
  let config: Config;
  let mode: ApprovalMode;
  try {
    root = resolveRoot(args.cwd);
    // One workspace root for everything: .env lookup, tool paths, and child
    // processes all resolve against the same directory.
    process.chdir(root);
    loadEnvFiles();
    config = loadConfig();
    mode = resolveMode(args.mode, process.env.COOPER_MODE);
  } catch (error) {
    fail(error);
  }

  if (args.prompt !== null) {
    const prompt = (
      args.prompt === "-" ? await readStdin() : args.prompt
    ).trim();
    if (prompt === "") fail(new Error("Empty prompt."));

    const controller = new AbortController();
    process.once("SIGINT", () => controller.abort());

    const provider = new OpenAICompatibleProvider({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
    });

    const code = await runHeadless({
      config,
      root,
      mode,
      prompt,
      provider,
      out: process.stdout,
      err: process.stderr,
      signal: controller.signal,
    });
    process.exitCode = code;
    return;
  }

  const { waitUntilExit } = render(
    <App config={config} root={root} mode={mode} />,
    { exitOnCtrlC: false },
  );
  await waitUntilExit();
}

main().catch((error) => fail(error));
