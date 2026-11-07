#!/usr/bin/env node
import React from "react";
import { render } from "ink";
import { App } from "./app.js";
import { loadConfig, loadEnvFiles, type ApprovalMode } from "./config.js";

const HELP = `Cooper — a terminal coding agent

Usage:
  cooper [--mode ask|auto|plan]

Modes:
  ask    (default) ask before file writes and command execution
  auto   approve every tool call without asking (use with care)
  plan   read-only: inspect files, deny writes and commands

Environment:
  COOPER_API_KEY    API key (falls back to OPENAI_API_KEY)
  COOPER_BASE_URL   OpenAI-compatible endpoint
  COOPER_MODEL      Model name
  COOPER_MODE       Default approval mode (flag wins)
`;

function parseMode(value: string | undefined, source: string): ApprovalMode {
  if (value === "ask" || value === "auto" || value === "plan") return value;
  throw new Error(
    `Invalid ${source} "${value ?? ""}". Use ask, auto, or plan.`,
  );
}

function parseArgs(argv: string[]): { mode: ApprovalMode; help: boolean } {
  const fromEnv = process.env.COOPER_MODE;
  let mode: ApprovalMode =
    fromEnv === undefined || fromEnv === ""
      ? "ask"
      : parseMode(fromEnv, "COOPER_MODE");

  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--mode" || arg === "-m") {
      const value = argv[index + 1];
      mode = parseMode(value, "--mode");
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}. Try --help.`);
    }
  }

  return { mode, help };
}

function main(): void {
  loadEnvFiles();

  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }

  if (args.help) {
    console.log(HELP);
    return;
  }

  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig();
  } catch (error) {
    console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }

  const { waitUntilExit } = render(
    <App config={config} root={process.cwd()} mode={args.mode} />,
    { exitOnCtrlC: false },
  );

  waitUntilExit().catch(() => process.exit(1));
}

main();
