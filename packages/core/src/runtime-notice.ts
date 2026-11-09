import type { PermissionPreset } from "./permissions.js";
import type { Message, RuntimeNoticeKind } from "./types.js";

/** Marker for the permission-mode runtime notice. */
export const PERMISSION_MODE_RUNTIME: RuntimeNoticeKind = "permission-mode";

const MODE_TEXT: Record<PermissionPreset, string> = {
  plan:
    "Permission mode is now plan (read-only). This supersedes earlier runtime notices.\n" +
    "Inspect files and gather context only. Do not modify files or run state-changing commands. " +
    "Present a plan and wait for the user to switch modes.",
  ask:
    "Permission mode is now ask. This supersedes earlier runtime notices.\n" +
    "File edits and commands require user approval. Do not retry a denied call.",
  auto:
    "Permission mode is now auto. This supersedes earlier runtime notices.\n" +
    "All tools are auto-approved; choose actions carefully.",
};

/**
 * The model-visible notice that carries the current permission mode. It is a
 * user-role message because every provider supports that role; the runtime
 * marker keeps hosts from rendering it as user input. The text is fixed so
 * appending it does not perturb the cached prefix.
 */
export function permissionModeNotice(preset: PermissionPreset): Message {
  return {
    role: "user",
    content:
      `<cooper-runtime mode="${preset}">\n` +
      `${MODE_TEXT[preset]}\n` +
      "</cooper-runtime>",
    runtime: PERMISSION_MODE_RUNTIME,
  };
}

/** True for any host-authored runtime notice, regardless of its kind. */
export function isRuntimeNotice(message: Message): boolean {
  return message.role === "user" && message.runtime !== undefined;
}

/**
 * The newest runtime notice in a transcript. Compaction uses this to keep the
 * current permission mode visible even when it summarizes or drops the prefix
 * that originally contained the notice.
 */
export function latestRuntimeNotice(
  messages: readonly Message[],
): Message | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message !== undefined && isRuntimeNotice(message)) return message;
  }
  return undefined;
}
