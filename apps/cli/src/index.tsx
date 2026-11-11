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
  type ModeResolution,
  type ParsedArgs,
} from "./args.js";
import {
  IncompleteConfigError,
  applyEnvFile,
  loadConfig,
  type ApprovalMode,
  type Config,
} from "./config.js";
import { runHeadless } from "./headless.js";
import { prepareTools, type PreparedTools } from "./mcp.js";
import {
  runOnboarding,
  writeOnboardingConfig,
} from "./onboarding.js";
import { createProvider } from "./provider.js";
import { userConfigFile } from "./settings.js";

const HELP = `Cooper — a terminal coding agent

Usage:
  cooper                          start the interactive TUI
  cooper "fix the failing test"   one-shot; prints the answer to stdout
  cooper -p - < prompt.txt        read the prompt from stdin

Options:
  -m, --mode <mode>   ask (default) | auto | plan
      --model <name>  model for this run (overrides env and config)
      --env-file <f>  load env vars from <f>; overrides the ambient env
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

Configuration:
  Everything lives in ~/.cooper/config.json (protocol, model, context, and
  an "env" object for COOPER_API_KEY / COOPER_BASE_URL). Precedence per key:
  --env-file > environment > config.json > defaults. model has no default —
  it must come from --model, COOPER_MODEL, or config.json. No workspace files
  are read. Run cooper interactively once to be guided through setup.

Environment:
  COOPER_API_KEY     API key (or set it under "env" in config.json)
  COOPER_PROTOCOL    openai-chat (default) | anthropic-messages
  COOPER_BASE_URL    Endpoint URL (required; no silent default)
  COOPER_MODEL       Model name (required; no built-in default)
  COOPER_MAX_OUTPUT_TOKENS
                     Anthropic max_tokens (default 64000)
  COOPER_MODE        Default approval mode (flag wins)
  COOPER_SHOW_REASONING
                     Set to 1 to show reasoning summaries by default

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
  let modeSource: ModeResolution["source"] = "default";
  let modeNotice: string | undefined;
  let instructions: LoadedInstructions;
  let session: SessionWriter | null = null;
  let resumed: LoadedSession | null = null;
  try {
    // --env-file is an explicit per-run override: it wins over the ambient
    // environment, so apply it before any config resolution reads env.
    if (args.envFile !== null) applyEnvFile(args.envFile);

    // Any missing required field (protocol/model/baseURL/apiKey) + interactive
    // TUI is the one entry point into onboarding; headless and every other
    // config error fail closed as before.
    try {
      config = loadConfig({ overrides: { model: args.model } });
    } catch (error) {
      const interactiveTui =
        error instanceof IncompleteConfigError &&
        args.prompt === null &&
        process.stdin.isTTY === true &&
        process.stdout.isTTY === true;
      if (!interactiveTui) throw error;

      const result = await runOnboarding();
      if (result === null) {
        fail(
          `Setup cancelled. Set protocol, model, baseURL, and ` +
            `COOPER_API_KEY in ${userConfigFile()} (or the environment), ` +
            `then run cooper again.`,
        );
      }
      writeOnboardingConfig(undefined, result);
      config = loadConfig({ overrides: { model: args.model } });
    }

    for (const warning of config.settingsWarnings) {
      console.error(`warning: ${warning}`);
    }
    instructions = await loadProjectInstructions(root);

    if (args.resume !== null) {
      resumed = resumeSession({ cwd: root, id: args.resume });
    }

    const resolution = resolveModeForSession(
      args.mode,
      process.env.COOPER_MODE,
      resumed?.preset ?? null,
      config.defaultMode ?? null,
    );
    mode = resolution.mode;
    modeSource = resolution.source;
    if (resolution.sessionAutoIgnored) {
      modeNotice =
        `Saved session was in auto mode; not restored (now ${mode}). ` +
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

  // The flag always wins; record it so /status reports the true source.
  if (args.showReasoning) {
    config.showReasoning = true;
    config.sources.showReasoning = "flag";
  }
  const showReasoning = config.showReasoning;
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
        modeSource={modeSource}
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
