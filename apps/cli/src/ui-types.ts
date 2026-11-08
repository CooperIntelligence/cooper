/** Rows committed to the TUI's <Static> region. Shared with session replay. */

export type ToolStatus = "running" | "ok" | "error" | "denied";

export type UiItem =
  | { id: number; kind: "user"; text: string }
  | { id: number; kind: "assistant-line"; text: string; first: boolean }
  | { id: number; kind: "reasoning-line"; text: string }
  | {
      id: number;
      kind: "tool";
      name: string;
      summary: string;
      status: ToolStatus;
      output?: string;
      durationMs?: number;
    }
  | { id: number; kind: "notice"; text: string; tone: "info" | "error" };
