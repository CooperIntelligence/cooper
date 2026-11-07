import path from "node:path";
import type { InstructionSource } from "@cooper/core";
import type { ApprovalMode } from "./config.js";

/** Short label for the startup banner: relative to the workspace when inside it. */
export function describeInstructions(
  sources: InstructionSource[],
  root: string,
): string {
  if (sources.length === 0) return "none";
  return sources
    .map(({ path: file }) => {
      const relative = path.relative(root, file);
      return relative.startsWith("..") ? file : relative;
    })
    .join(", ");
}

/**
 * The single place the agent's instructions are written. Shared by the TUI and
 * headless runs so the two surfaces never disagree about what is allowed.
 */
export function buildSystemPrompt(options: {
  root: string;
  mode: ApprovalMode;
  interactive: boolean;
  /** Loaded COOPER.md / AGENTS.md content, if any. */
  instructions?: string;
}): string {
  const { root, mode, interactive } = options;

  let permission: string;
  if (mode === "plan") {
    permission =
      "You are in plan mode: inspect files only. Do not modify files or run commands. Produce a plan for the user to approve.";
  } else if (mode === "auto") {
    permission =
      "You may inspect files, edit files, and run shell commands. Tool calls are approved automatically, so choose carefully before acting.";
  } else if (interactive) {
    permission =
      "You may inspect files, edit files, and run shell commands. Tools that change the workspace or execute commands require user approval.";
  } else {
    // Non-interactive ask: nobody can answer the prompt, so fail closed.
    permission =
      "This is a non-interactive run: tools that change the workspace or execute commands will be denied. Do not retry a denied tool; explain what you would do instead.";
  }

  const lines = [
    `You are Cooper, a terminal coding agent working in the project at ${root}.`,
    permission,
    "Prefer read_file/grep over guessing, and edit_file over write_file for targeted changes.",
    "Keep changes minimal and verify your work by running tests when appropriate.",
    "Be concise and reply in the same language as the user.",
  ];

  const instructions = options.instructions?.trim();
  if (instructions !== undefined && instructions.length > 0) {
    lines.push(
      "",
      "Project instructions follow. Follow them where they do not conflict",
      "with the permission rules above.",
      "",
      instructions,
    );
  }

  return lines.join("\n");
}
