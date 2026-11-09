#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import React from "react";
import { render } from "ink";
import {
  SessionWriter,
  listSessions,
  loadProjectInstructions,
  resumeSession,
  sessionsDir,
  type LoadedInstructions,
  type LoadedSession,
} from "@cooper/core";
import { App } from "./app.js";
import {
  parseArgs,
  resolveModeForSession,
  type ParsedArgs,
} from "./args.js";
import {
  loadConfig,
  loadEnvFiles,
  type ApprovalMode,
  type Config,
} from "./config.js";
import { runHeadless } from "./headless.js";
import { prepareTools, type PreparedTools } from "./mcp.js";
import { createProvider } from "./provider.js";

const HELP = `Cooper — a terminal coding agent

Usage:
  cooper                          start the interactive TUI
  cooper "fix the failing test"   one-shot; prints the answer to stdout
  cooper -p - < prompt.txt        read the prompt from stdin

Options:
  -m, --mode <mode>   ask (default) | auto | plan
  -C, --cwd <dir>     workspace directory (default: current directory)
  -p, --print [text]  non-interactive; omit text or use "-" for stdin
  -r, --resume <id>   continue a saved session
      --sessions      list saved sessions for this workspace and exit
      --no-session    do not save this run's conversation
      --mcp-config <file>
                      load an MCP server config (repeatable)
      --mcp-project   allow <workspace>/.cooper/mcp.json
      --show-reasoning
                      stream the model's reasoning summary (dim, display-only)
  -h, --help          show this help

Modes:
  ask    ask before file writes and command execution
  auto   approve every tool call without asking (use with care)
  plan   read-only: inspect files, deny writes and commands

  With -p nobody can answer an approval prompt, so ask denies writes and
  commands; pass --mode auto for unattended edits.

Environment:
  COOPER_PROVIDER   openai (default) | anthropic
  COOPER_API_KEY    API key (falls back to OPENAI_API_KEY / ANTHROPIC_API_KEY)
  COOPER_BASE_URL   Endpoint override (provider-specific env wins)
  COOPER_MODEL      Model name (default: gpt-4o-mini or claude-opus-5-5)
  COOPER_MAX_OUTPUT_TOKENS
                    Anthropic max_tokens (default 64000)
  COOPER_MODE       Default approval mode (flag wins)
  COOPER_SHOW_REASONING
                    Set to 1 to show reasoning summaries by default
  COOPER_HOME       Data directory (default: ~/.cooper)

.env is read from the workspace, then from the directory next to Cooper.
Sessions are saved by default; use --no-session to keep a run ephemeral.
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

function printSessions(root: string): void {
  const dir = sessionsDir(root);
  const sessions = listSessions(dir);
  if (sessions.length === 0) {
    console.log(`No saved sessions for ${root}.`);
    return;
  }

  console.log(`Sessions for ${root}`);
  console.log(dir);
  for (const entry of sessions) {
    const when = new Date(entry.updatedAt).toLocaleString();
    console.log(
      `${entry.id}  ${when}  ${entry.model}  ${entry.preview}`,
    );
  }
  console.log("\nResume with: cooper --resume <id>");
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
  try {
    root = resolveRoot(args.cwd);
    // One workspace root for everything: .env lookup, tool paths, session
    // buckets, and child processes all resolve against the same directory.
    process.chdir(root);
  } catch (error) {
    fail(error);
  }

  if (args.sessions) {
    printSessions(root);
    return;
  }

  let config: Config;
  let mode: ApprovalMode;
  let modeNotice: string | undefined;
  let instructions: LoadedInstructions;
  let session: SessionWriter | null = null;
  let resumed: LoadedSession | null = null;
  try {
    loadEnvFiles();
    config = loadConfig();
    instructions = await loadProjectInstructions(root);

    if (args.resume !== null) {
      resumed = resumeSession({ cwd: root, id: args.resume });
    }

    const resolution = resolveModeForSession(
      args.mode,
      process.env.COOPER_MODE,
      resumed?.preset ?? null,
    );
    mode = resolution.mode;
    if (resolution.sessionAutoIgnored) {
      modeNotice =
        "Saved session was in auto mode; resumed in ask. " +
        "Pass --mode auto or run /auto to enable auto-approve.";
    } else if (resolution.source === "session") {
      modeNotice = `Restored from session: ${mode}.`;
    }

    if (args.resume !== null && resumed !== null) {
      session = args.session ? SessionWriter.from(resumed) : null;
    } else if (args.session) {
      session = SessionWriter.create({ cwd: root, model: config.model });
    }
  } catch (error) {
    fail(error);
  }

  const showReasoning = args.showReasoning || config.showReasoning;
  const provider = createProvider(config);

  let prepared: PreparedTools;
  try {
    prepared = await prepareTools({
      root,
      explicit: args.mcpConfig,
      loadProject: args.mcpProject,
    });
  } catch (error) {
    fail(error);
  }
  const { tools, mcp } = prepared;

  if (args.prompt !== null) {
    const prompt = (
      args.prompt === "-" ? await readStdin() : args.prompt
    ).trim();
    if (prompt === "") fail(new Error("Empty prompt."));

    const controller = new AbortController();
    process.once("SIGINT", () => controller.abort());

    let code: number;
    try {
      code = await runHeadless({
        config,
        root,
        mode,
        prompt,
        provider,
        instructions,
        showReasoning,
        tools,
        mcp,
        modeNotice,
        out: process.stdout,
        err: process.stderr,
        signal: controller.signal,
        session,
        resumed,
      });
    } finally {
      await prepared.close();
    }
    process.exitCode = code;
    return;
  }

  try {
    const { waitUntilExit } = render(
      <App
        config={config}
        root={root}
        mode={mode}
        instructions={instructions}
        showReasoning={showReasoning}
        provider={provider}
        tools={tools}
        mcp={mcp}
        modeNotice={modeNotice}
        session={session}
        resumed={resumed}
      />,
      { exitOnCtrlC: false },
    );
    await waitUntilExit();
  } finally {
    await prepared.close();
  }
}

main().catch((error) => fail(error));
