#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { isSea } from "node:sea";
import { fileURLToPath } from "node:url";
import React from "react";
import { render } from "ink";
import cliPackage from "../package.json" with { type: "json" };
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
import { reloadReadySession } from "./session-run.js";
import {
  parseArgs,
  resolveModeForSession,
  type ModeResolution,
  type ParsedArgs,
} from "./args.js";
import {
  IncompleteConfigError,
  loadConfig,
  selectModelTier,
  localShellSandbox,
  shellSandboxPlatform,
  windowsAgentShell,
  writeOnboardingConfig,
  type ApprovalMode,
  type Config,
} from "@cooper/host";
import { runHeadless } from "./headless.js";
import { prepareTools, type PreparedTools } from "@cooper/host";
import { runOnboarding } from "./onboarding.js";
import { createProvider } from "@cooper/host";
import { userConfigFile } from "@cooper/host";

declare const COOPER_BUILD_VERSION: string | undefined;
const cliVersion = typeof COOPER_BUILD_VERSION === "string" ? COOPER_BUILD_VERSION : cliPackage.version;

const HELP = `Cooper — a terminal coding agent

Usage:
  cooper                          start the interactive TUI
  cooper --version                print the CLI version
  cooper -p "fix the failing test"  one-shot; prints the answer to stdout
  cooper -p - < prompt.txt        read the prompt from stdin
  cooper update [--check]         online update command (updater pending)
  cooper rollback                 activate the previous native CLI version

Options:
  -m, --mode <mode>   override the startup mode: ask | auto | plan
  -C, --cwd <dir>     workspace directory (default: current directory)
  -p, --print [text]  non-interactive; omit text or use "-" for stdin
  -r, --resume <id>   continue a saved session
      --tier <tier>   select sera | cher | thr (overrides a saved tier)
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
  auto   apply automatic approval rules; shell requires a supported sandbox
  plan   read-only: inspect files, deny writes, commands, and web requests

  With -p nobody can answer an approval prompt, so ask denies writes,
  commands, and web requests. On Windows and Linux, auto checks routine edits and
  reviews shell commands separately. Calls needing user approval are denied with -p.
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
  const native = isSea();
  const entry = native ? process.execPath : fileURLToPath(import.meta.url);
  const linuxSourceRuntime = entry.endsWith(".tsx") ? path.resolve(path.dirname(entry), "../dist") : path.dirname(entry);
  const appDirectory = native ? path.dirname(process.execPath)
    : process.platform === "linux"
      ? process.env.COOPER_LINUX_RUNTIME_DIR ?? linuxSourceRuntime
      : process.env.COOPER_WINDOWS_RUNTIME_DIR ?? path.dirname(entry);
  const windowsShell = windowsAgentShell(appDirectory);
  let args: ParsedArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    fail(error);
  }

  if (args.version) {
    console.log(cliVersion);
    return;
  }

  if (args.maintenance === "rollback") {
    fail("Rollback requires Cooper's native launcher. Run cooper rollback from the native installation.");
  }
  if (args.maintenance !== undefined) {
    fail("Online updates are unavailable in this build. For an npm installation, use npm to update Cooper.");
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
      config = loadConfig({ showReasoning: args.showReasoning, windowsShell });
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
      config = loadConfig({ showReasoning: args.showReasoning, windowsShell });
    }

    for (const warning of config.settingsWarnings) {
      console.error(`warning: ${warning}`);
    }
    instructions = await loadProjectInstructions(root);

    if (args.resume !== null) {
      resumed = resumeSession({ cwd: root, id: args.resume });
      if (resumed.header.version === 2) {
        if (!args.session) throw new Error("Resuming a v2 conversation requires session writes.");
        session = SessionWriter.from(resumed, { writeV2: true });
        resumed = reloadReadySession(session);
      }
    }
    config = selectModelTier(config, args.tier ?? (resumed?.modelSelection ? resumed.modelSelection.tier : undefined));

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
          ? "Pass --mode auto or run /auto to enable Auto mode."
          : "Pass --mode auto to enable Auto mode.");
    } else if (resolution.source === "session") {
      modeNotice = `Restored from session: ${mode}.`;
    }

    if (args.resume !== null && resumed !== null) {
      session ??= args.session ? SessionWriter.from(resumed) : null;
    } else if (args.session) {
      session = SessionWriter.create({ cwd: root, model: config.model });
    }
  } catch (error) {
    fail(error);
  }

  const showReasoning = config.showReasoning;
  const provider = createProvider(config);

  const skills = await discoverSkills(root);
  const shellSandbox = localShellSandbox(appDirectory);
  if (shellSandboxPlatform && mode === "auto" && !shellSandbox) {
    session?.close();
    fail(new Error("Auto requires the Cooper shell sandbox. Install or build the sandbox runtime for this platform."));
  }
  let prepared: PreparedTools;
  try {
    prepared = await prepareTools({
      root,
      explicit: args.mcpConfig,
      loadProject: args.mcpProject,
      shell: config.shell,
      webSearch: config.webSearch,
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
        shellSandbox,
        sandboxPlatform: shellSandboxPlatform,
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
      session?.close();
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
        shellSandbox={shellSandbox}
        sandboxPlatform={shellSandboxPlatform}
        windowsShell={windowsShell}
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
    session?.close();
    await prepared.close();
  }
}

main().catch((error) => fail(error));
