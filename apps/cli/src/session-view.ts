import {
  isRuntimeNotice,
  toolCallIndex,
  type LoadedSession,
} from "@cooper/core";
import { splitContent } from "./stream-lines.js";
import type { ToolStatus, UiItem } from "./ui-types.js";

/** Context-compaction replacements are context, not something the user typed. */
const SUMMARY_STUB = /^\[Earlier conversation summary/;
const TRUNCATE_STUB = /^\[\d+ earlier messages were dropped/;

function isContextStub(content: string): boolean {
  return SUMMARY_STUB.test(content) || TRUNCATE_STUB.test(content);
}

/** Keep a resumed stub readable without dumping a whole summary into Static. */
function stubText(content: string): string {
  const lines = content.split(/\r?\n/);
  const shown = lines.slice(0, 6);
  if (lines.length > shown.length) shown.push("…");
  return shown.join("\n");
}

/**
 * Rebuilds the visible transcript for a resumed session. Reasoning is absent
 * by design (never persisted); tool rows use the recorded display metadata,
 * falling back to the assistant call when an older record has none.
 */
export function buildResumeView(
  session: LoadedSession,
  startId: number,
): { items: UiItem[]; nextId: number } {
  let id = startId;
  const items: UiItem[] = [];
  const calls = toolCallIndex(session.messages);

  for (let index = 0; index < session.messages.length; index += 1) {
    const message = session.messages[index];
    if (message === undefined) continue;

    if (message.role === "user") {
      if (isRuntimeNotice(message)) continue;
      if (isContextStub(message.content)) {
        items.push({
          id: id++,
          kind: "notice",
          tone: "info",
          text: stubText(message.content),
        });
      } else {
        items.push({ id: id++, kind: "user", text: message.content });
      }
      continue;
    }

    if (message.role === "assistant") {
      if (message.content.length === 0) continue;
      splitContent(message.content).forEach((line, lineIndex) => {
        items.push({
          id: id++,
          kind: "assistant-line",
          text: line,
          first: lineIndex === 0,
        });
      });
      continue;
    }

    // Loaded histories never contain system messages, but the Message union
    // still has to be narrowed for the compiler.
    if (message.role !== "tool") continue;

    const ui = session.toolUi.get(index);
    const call = calls.get(message.toolCallId);
    const name = ui?.toolName ?? call?.name ?? "tool";
    const summary =
      ui?.summary ??
      (call !== undefined
        ? `${call.name} ${call.arguments.replace(/\s+/g, " ").trim()}`
        : name);
    const status: ToolStatus = ui?.denied
      ? "denied"
      : ui?.isError
        ? "error"
        : "ok";

    items.push({
      id: id++,
      kind: "tool",
      name,
      summary,
      status,
      output: message.content,
      durationMs: ui?.durationMs,
    });
  }

  return { items, nextId: id };
}
