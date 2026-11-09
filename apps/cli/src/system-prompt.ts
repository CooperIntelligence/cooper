import path from "node:path";
import type { InstructionSource, PermissionPolicy } from "@cooper/core";

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
  /**
   * The same policy the agent loop enforces. Deriving the text from it keeps
   * the instructions and the actual permission decisions from drifting.
   */
  permissions: PermissionPolicy;
  /** Loaded COOPER.md / AGENTS.md content, if any. */
  instructions?: string;
}): string {
  const { root, permissions } = options;

  // Keep this section mode-neutral. The current mode arrives in a runtime
  // notice appended to the conversation; rebuilding this text on every mode
  // change would invalidate the provider's prompt cache from the system
  // prompt onward. `interactive` is fixed for the process, so it is safe.
  const permission = permissions.interactive
    ? "The host enforces tool permissions. Write and execute tools may require user approval or be denied. The current permission mode is provided in the latest <cooper-runtime> message; earlier notices are superseded. If a tool is denied, do not retry the same call; explain what you intended and ask how to proceed."
    : "This is a non-interactive run: the host enforces tool permissions and gated tools are denied. The current permission mode is provided in the latest <cooper-runtime> message. Do not retry a denied tool; explain what you would do instead.";

  const lines = [
    `You are Cooper, a terminal coding agent working in the project at ${root}.`,
    permission,
    "Permission mode semantics: plan is read-only; ask requires approval for writes and commands; auto approves all tools.",
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
