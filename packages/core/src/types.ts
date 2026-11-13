/**
 * UI-agnostic message and tool types shared by every surface (TUI, desktop, server).
 */

import type { Continuation } from "./provider/continuation.js";

export type ToolCall = {
  id: string;
  name: string;
  /** Raw JSON string as produced by the model. */
  arguments: string;
};

/**
 * Legacy opaque per-provider continuation data. New code writes
 * `Message.continuation`; this field is read only so older session files can
 * still be resumed.
 */
export type ProviderData = Record<string, unknown>;

/**
 * Host-authored context that is model-visible but must never be presented as
 * user input. `permission-mode` carries the latest permission mode notice.
 */
export type RuntimeNoticeKind = "permission-mode" | "skill";

export type Message =
  | { role: "system"; content: string }
  | { role: "user"; content: string; runtime?: RuntimeNoticeKind }
  | {
      role: "assistant";
      content: string;
      toolCalls?: ToolCall[];
      /** Protocol state that must be replayed to the same provider. */
      continuation?: Continuation;
      /** Legacy continuation data read from older sessions. */
      providerData?: ProviderData;
    }
  | { role: "tool"; toolCallId: string; content: string; isError?: boolean };

export type ToolSpec = {
  name: string;
  description: string;
  /** JSON Schema object describing the tool input. */
  parameters: Record<string, unknown>;
};
