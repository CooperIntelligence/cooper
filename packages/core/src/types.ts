/**
 * UI-agnostic message and tool types shared by every surface (TUI, desktop, server).
 */

export type ToolCall = {
  id: string;
  name: string;
  /** Raw JSON string as produced by the model. */
  arguments: string;
};

/**
 * Opaque per-provider continuation data. Anthropic, for example, requires its
 * signed thinking blocks to be replayed with tool results. This data is never
 * rendered as conversation content and is only read by the provider that
 * produced it.
 */
export type ProviderData = Record<string, unknown>;

/**
 * Host-authored context that is model-visible but must never be presented as
 * user input. `permission-mode` carries the latest permission mode notice.
 */
export type RuntimeNoticeKind = "permission-mode";

export type Message =
  | { role: "system"; content: string }
  | { role: "user"; content: string; runtime?: RuntimeNoticeKind }
  | {
      role: "assistant";
      content: string;
      toolCalls?: ToolCall[];
      providerData?: ProviderData;
    }
  | { role: "tool"; toolCallId: string; content: string };

export type ToolSpec = {
  name: string;
  description: string;
  /** JSON Schema object describing the tool input. */
  parameters: Record<string, unknown>;
};
