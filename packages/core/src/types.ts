/**
 * UI-agnostic message and tool types shared by every surface (TUI, desktop, server).
 */

export type ToolCall = {
  id: string;
  name: string;
  /** Raw JSON string as produced by the model. */
  arguments: string;
};

export type Message =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

export type ToolSpec = {
  name: string;
  description: string;
  /** JSON Schema object describing the tool input. */
  parameters: Record<string, unknown>;
};
