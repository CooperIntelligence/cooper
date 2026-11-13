/** Rows committed to the TUI's <Static> region. Shared with session replay. */

import type { MarkdownLine } from "./markdown.js";

export type ToolStatus = "running" | "ok" | "error" | "denied";

export type UiItem =
  | { id: number; kind: "header"; model: string; root: string; autoApprove: boolean; resume?: string }
  | { id: number; kind: "user"; text: string }
  | { id: number; kind: "assistant-line"; line: MarkdownLine; first: boolean }
  | { id: number; kind: "reasoning-line"; text: string }
  | {
      id: number;
      kind: "tool";
      name: string;
      summary: string;
      status: ToolStatus;
      output?: string;
      durationMs?: number;
      processGrant?: boolean;
    }
  | { id: number; kind: "notice"; text: string; tone: "info" | "error" };
