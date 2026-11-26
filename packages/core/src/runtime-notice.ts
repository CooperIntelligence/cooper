import type { PermissionPreset } from "./permissions.js";
import type { ShellSandboxPlatform } from "./tools/shell-sandbox.js";
import type { Message, RuntimeNoticeKind } from "./types.js";

/** Marker for the permission-mode runtime notice. */
export const PERMISSION_MODE_RUNTIME: RuntimeNoticeKind = "permission-mode";

const MODE_TEXT: Record<PermissionPreset, string> = {
  plan:
    "Permission mode is now plan (read-only). This supersedes earlier runtime notices.\n" +
    "Inspect files and gather context only. Do not modify files, execute commands, or use web tools. " +
    "Present a plan and wait for the user to switch modes.",
  ask:
    "Permission mode is now ask. This supersedes earlier runtime notices.\n" +
    "File edits, commands, and web requests require user approval. Approved shell commands run as the host user. " +
    "Do not retry a denied call.",
  auto:
    "Permission mode is now auto. This supersedes earlier runtime notices.\n" +
    "Tool calls skip interactive approval. The built-in shell requires an available sandbox. " +
    "Do not retry a denied action through another tool.",
};

/**
 * The model-visible notice that carries the current permission mode. It is a
 * user-role message because every provider supports that role; the runtime
 * marker keeps hosts from rendering it as user input. The text is fixed so
 * appending it does not perturb the cached prefix.
 */
export function permissionModeNotice(preset: PermissionPreset, platform?: ShellSandboxPlatform): Message {
  const content = platform && preset !== "plan"
    ? `Permission mode is now ${preset}. This supersedes earlier runtime notices.\n` +
      (preset === "ask" ? "Gated calls require user approval. " :
        "Routine workspace edits can proceed; shell requires separate review. Sensitive edits and other gated tools require the user. ") +
      "Shell commands run in MXC Bubblewrap. Outbound access requires a workspace grant from the user's configuration. " +
      "The project and private per-call temp are writable. Check computed paths before deletes. " +
      "Do not retry a denied action through another tool."
    : MODE_TEXT[preset];
  return {
    role: "user",
    content:
      `<cooper-runtime mode="${preset}">\n` +
      `${content}\n` +
      "</cooper-runtime>",
    runtime: PERMISSION_MODE_RUNTIME,
  };
}

/** True for any host-authored runtime notice, regardless of its kind. */
export function isRuntimeNotice(message: Message): boolean {
  return message.role === "user" && message.runtime !== undefined;
}

/**
 * The newest permission notice in a transcript. Compaction uses this to keep the
 * current permission mode visible even when it summarizes or drops the prefix
 * that originally contained the notice.
 */
export function latestRuntimeNotice(
  messages: readonly Message[],
): Message | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user" && message.runtime === PERMISSION_MODE_RUNTIME) return message;
  }
  return undefined;
}
