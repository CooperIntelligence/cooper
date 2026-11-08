import type { ApprovalMode } from "./config.js";

export type ParsedArgs = {
  /** Explicit --mode. undefined means "fall back to COOPER_MODE, then ask". */
  mode: ApprovalMode | undefined;
  /** Workspace directory. undefined means "the launch directory". */
  cwd: string | undefined;
  /** Prompt for a non-interactive run. "-" means read stdin. null starts the TUI. */
  prompt: string | null;
  /** Stream the model's reasoning summary instead of just an indicator. */
  showReasoning: boolean;
  /** Session id to continue. null starts a fresh conversation. */
  resume: string | null;
  /** Persist this run to a session file. `--no-session` turns it off. */
  session: boolean;
  /** List sessions for the workspace and exit. */
  sessions: boolean;
  help: boolean;
};

function isMode(value: string): value is ApprovalMode {
  return value === "ask" || value === "auto" || value === "plan";
}

function parseModeValue(value: string | undefined): ApprovalMode {
  if (value !== undefined && isMode(value)) return value;
  throw new Error(`Invalid --mode "${value ?? ""}". Use ask, auto, or plan.`);
}

/**
 * Parses argv into CLI options. Pure: no I/O, no env reads, so it is unit
 * testable without booting Ink.
 *
 * Accepted forms:
 *   cooper                                interactive
 *   cooper "fix the tests"                shorthand for --print
 *   cooper -p "..." / --print=...         non-interactive
 *   cooper -p -   / -p                    prompt from stdin
 *   -m/--mode, -C/--cwd, --flag=value
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    mode: undefined,
    cwd: undefined,
    prompt: null,
    showReasoning: false,
    resume: null,
    session: true,
    sessions: false,
    help: false,
  };

  const takeValue = (index: number, flag: string): string => {
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${flag} requires a value.`);
    return value;
  };

  // A bare `-p` means "read stdin", but a positional prompt after intervening
  // flags (`-p --resume <id> "follow up"`) should win instead of being
  // rejected as a second prompt.
  let barePrint = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;

    // Support --flag=value in addition to --flag value.
    let name = arg;
    let inline: string | undefined;
    if (arg.startsWith("--")) {
      const equals = arg.indexOf("=");
      if (equals !== -1) {
        name = arg.slice(0, equals);
        inline = arg.slice(equals + 1);
      }
    }

    switch (name) {
      case "--help":
      case "-h": {
        parsed.help = true;
        break;
      }

      case "--mode":
      case "-m": {
        let value = inline;
        if (value === undefined) {
          value = takeValue(index, name);
          index += 1;
        }
        parsed.mode = parseModeValue(value);
        break;
      }

      case "--cwd":
      case "-C": {
        let value = inline;
        if (value === undefined) {
          value = takeValue(index, name);
          index += 1;
        }
        if (value.trim() === "") throw new Error("--cwd requires a directory.");
        parsed.cwd = value;
        break;
      }

      case "--show-reasoning": {
        parsed.showReasoning = true;
        break;
      }

      case "--resume":
      case "-r": {
        let value = inline;
        if (value === undefined) {
          const next = argv[index + 1];
          // Session ids never start with a dash; that keeps `--resume -p`
          // from silently swallowing the next flag as an id.
          if (next !== undefined && !next.startsWith("-")) {
            value = next;
            index += 1;
          }
        }
        if (value === undefined || value.trim() === "") {
          throw new Error(`${name} requires a session id.`);
        }
        parsed.resume = value.trim();
        break;
      }

      case "--sessions": {
        parsed.sessions = true;
        break;
      }

      case "--no-session": {
        parsed.session = false;
        break;
      }

      case "--print":
      case "-p": {
        let value = inline;
        if (value === undefined) {
          const next = argv[index + 1];
          // "-" is the stdin sentinel; anything else starting with "-" is a
          // flag, not a prompt, so bare --print falls back to stdin.
          if (next !== undefined && (next === "-" || !next.startsWith("-"))) {
            value = next;
            index += 1;
          }
        }
        if (parsed.prompt !== null) {
          throw new Error("Only one prompt can be given.");
        }
        parsed.prompt = value ?? "-";
        barePrint = value === undefined;
        break;
      }

      default: {
        if (name.startsWith("-")) {
          throw new Error(`Unknown argument: ${arg}. Try --help.`);
        }
        if (parsed.prompt !== null) {
          if (barePrint) {
            parsed.prompt = arg;
            barePrint = false;
            break;
          }
          throw new Error(`Unexpected extra argument: ${arg}. Try --help.`);
        }
        parsed.prompt = arg;
        break;
      }
    }
  }

  if (parsed.resume !== null && !parsed.session) {
    throw new Error("--resume cannot be combined with --no-session.");
  }
  if (parsed.sessions && (parsed.prompt !== null || parsed.resume !== null)) {
    throw new Error("--sessions lists sessions and cannot run a prompt.");
  }

  return parsed;
}

/** Flag wins over COOPER_MODE, which wins over "ask". */
export function resolveMode(
  flag: ApprovalMode | undefined,
  envValue: string | undefined,
): ApprovalMode {
  if (flag !== undefined) return flag;
  if (envValue === undefined || envValue.trim() === "") return "ask";
  if (isMode(envValue)) return envValue;
  throw new Error(`Invalid COOPER_MODE "${envValue}". Use ask, auto, or plan.`);
}
