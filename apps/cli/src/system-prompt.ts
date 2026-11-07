import type { ApprovalMode } from "./config.js";

/**
 * The single place the agent's instructions are written. Shared by the TUI and
 * headless runs so the two surfaces never disagree about what is allowed.
 */
export function buildSystemPrompt(options: {
  root: string;
  mode: ApprovalMode;
  interactive: boolean;
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

  return [
    `You are Cooper, a terminal coding agent working in the project at ${root}.`,
    permission,
    "Prefer read_file/grep over guessing, and edit_file over write_file for targeted changes.",
    "Keep changes minimal and verify your work by running tests when appropriate.",
    "Be concise and reply in the same language as the user.",
  ].join("\n");
}
