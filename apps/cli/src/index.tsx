#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import React from "react";
import { render } from "ink";
import {
  SessionWriter,
  discoverSkills,
  listSessions,
  loadProjectInstructions,
  resumeSession,
  sessionsDir,
  type LoadedInstructions,
  type LoadedSession,
} from "@cooper/core";
import { App, tuiRenderOptions } from "./app.js";
import {
  parseArgs,
  resolveModeForSession,
  type ModeResolution,
  type ParsedArgs,
} from "./args.js";
import {
  IncompleteConfigError,
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
  -m, --mode <mode>   override the startup mode: ask | auto | plan
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
  ask    ask before file writes, commands, and web requests
  auto   approve every tool call without asking (use with care)
  plan   read-only: inspect files, deny writes, commands, and web requests

  With -p nobody can answer an approval prompt, so ask denies writes,
  commands, and web requests. Pass --mode auto to allow them.
  Startup precedence: --mode > saved plan/ask > config.json mode > ask.
  Config defaults accept plan and ask. In the TUI, /plan, /ask and /auto
  switch the mode while idle.

Configuration:
  Set protocol, model, baseURL, and apiKey in ~/.cooper/config.json.
  The supported protocols are openai-chat, anthropic-messages, and openai-responses.
  Run cooper interactively to complete setup.
  Use /config in the TUI to edit and apply settings.
  Use /reload to apply edits made to config.json elsewhere.

Sessions are saved by default; use --no-session to keep a run ephemeral.
Use /skills to list skills in the TUI, or /skill <name> [request] to use one.
In headless mode, pass '/skill <name> [request]' as the prompt.
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
    // Tools, sessions, and child processes share the same workspace root.
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

    // Any missing required field (protocol/model/baseURL/apiKey) + interactive
    // TUI is the one entry point into onboarding; headless and every other
    // config error fail closed as before.
    try {
      config = loadConfig({ showReasoning: args.showReasoning });
    } catch (error) {
      if (!(error instanceof IncompleteConfigError)) throw error;
      if (args.prompt !== null || !process.stdin.isTTY || !process.stdout.isTTY) {
        for (const warning of error.warnings) console.error(`warning: ${warning}`);
        throw error;
      }

      const result = await runOnboarding(error.settings);
      if (result === null) {
        fail(
          `Setup cancelled. Set protocol, model, baseURL, and ` +
            `apiKey in ${userConfigFile()}, ` +
            `then run cooper again.`,
        );
      }
      writeOnboardingConfig(undefined, result);
      config = loadConfig({ showReasoning: args.showReasoning });
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
      resumed?.preset ?? null,
      config.defaultMode,
    );
    mode = resolution.mode;
    modeSource = resolution.source;
    if (resolution.sessionAutoIgnored) {
      modeNotice =
        `Saved session was in auto mode; not restored (now ${mode}). ` +
        (args.prompt === null
          ? "Pass --mode auto or run /auto to enable auto-approve."
          : "Pass --mode auto to enable auto-approve.");
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

  const showReasoning = config.showReasoning;
  const provider = createProvider(config);

  const skills = await discoverSkills(root);
  let prepared: PreparedTools;
  try {
    prepared = await prepareTools({
      root,
      explicit: args.mcpConfig,
      loadProject: args.mcpProject,
      shell: config.shell,
      webSearchApiKey: config.webSearchApiKey,
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
        skills,
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
        skills={skills}
        showReasoningFlag={args.showReasoning}
        provider={provider}
        tools={tools}
        mcp={mcp}
        modeNotice={modeNotice}
        session={session}
        resumed={resumed}
      />,
      tuiRenderOptions,
    );
    await waitUntilExit();
  } finally {
    await prepared.close();
  }
}

main().catch((error) => fail(error));
