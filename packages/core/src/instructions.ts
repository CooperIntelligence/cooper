import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Instructions are user preferences plus repository conventions. They are
 * injected into the system prompt but can never override the permission
 * rules the host enforces.
 */
export const MAX_INSTRUCTION_CHARS = 32_000;

const GLOBAL_DIR = ".cooper";
const PROJECT_FILES = ["COOPER.md", "AGENTS.md"] as const;

export type InstructionSource = {
  path: string;
  /** Size of the original file, before any truncation. */
  chars: number;
  truncated: boolean;
};

export type LoadedInstructions = {
  /** Ready to append to the system prompt; empty when nothing was found. */
  text: string;
  sources: InstructionSource[];
};

async function isFile(file: string): Promise<boolean> {
  try {
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}

async function readTextFile(file: string): Promise<string | null> {
  try {
    return (await fs.readFile(file, "utf8")).trim();
  } catch {
    return null;
  }
}

/** COOPER.md wins over AGENTS.md; exactly one file is used per directory. */
async function findInstructionFile(dir: string): Promise<string | null> {
  for (const name of PROJECT_FILES) {
    const file = path.join(dir, name);
    if (await isFile(file)) return file;
  }
  return null;
}

/**
 * Loads, in order:
 *   1. `~/.cooper/COOPER.md` or `~/.cooper/AGENTS.md` (user preferences)
 *   2. `<root>/COOPER.md` or `<root>/AGENTS.md` (project conventions)
 *
 * Later text has more authority when the two disagree, so the project file
 * comes second. The combined text is capped so a huge instructions file
 * cannot quietly consume the context budget.
 */
export async function loadProjectInstructions(
  root: string,
  options: { home?: string; maxChars?: number } = {},
): Promise<LoadedInstructions> {
  const home = options.home ?? os.homedir();
  const maxChars = options.maxChars ?? MAX_INSTRUCTION_CHARS;

  const files: string[] = [];
  const globalFile = await findInstructionFile(path.join(home, GLOBAL_DIR));
  if (globalFile !== null) files.push(globalFile);
  const projectFile = await findInstructionFile(root);
  if (projectFile !== null && projectFile !== globalFile) {
    files.push(projectFile);
  }

  const parts: string[] = [];
  const sources: InstructionSource[] = [];
  let remaining = maxChars;

  for (const file of files) {
    const text = await readTextFile(file);
    if (text === null || text.length === 0) continue;

    let body = text;
    let truncated = false;
    if (body.length > remaining) {
      body = body.slice(0, Math.max(0, remaining)).trimEnd();
      truncated = true;
    }

    sources.push({ path: file, chars: text.length, truncated });
    if (body.length === 0) continue;
    remaining -= body.length;

    parts.push(
      `<file path="${file}">\n${body}` +
        (truncated ? "\n\n[truncated to fit the instructions budget]" : "") +
        "\n</file>",
    );
  }

  return { text: parts.join("\n\n"), sources };
}
