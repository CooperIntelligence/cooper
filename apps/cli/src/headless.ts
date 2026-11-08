import {
  allTools,
  PermissionPolicy,
  runAgent,
  type LoadedInstructions,
  type LoadedSession,
  type Message,
  type Provider,
  type SessionWriter,
} from "@cooper/core";
import type { ApprovalMode, Config } from "./config.js";
import { buildSystemPrompt, describeInstructions } from "./system-prompt.js";

/** Minimal sink so tests can capture output without real streams. */
export type Writer = { write(chunk: string): unknown };

export type HeadlessOptions = {
  config: Config;
  root: string;
  mode: ApprovalMode;
  prompt: string;
  provider: Provider;
  instructions: LoadedInstructions;
  /** Write the reasoning summary to stderr (stdout stays answer-only). */
  showReasoning: boolean;
  /** Assistant text. Kept clean so it can be piped or redirected. */
  out: Writer;
  /** Tool activity, warnings, and errors. */
  err: Writer;
  signal?: AbortSignal;
  /** Persists the conversation. Omitted by tests and `--no-session` runs. */
  session?: SessionWriter | null;
  /** Conversation to continue, when `--resume` was used. */
  resumed?: LoadedSession | null;
};

const ICONS = { ok: "✓", error: "✗", denied: "⊘" } as const;

function oneLine(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}

/**
 * Runs one prompt without the TUI and returns a process exit code.
 *
 * There is no one to answer an approval prompt here, so fail closed: only
 * `auto` allows approval-gated tools; `ask` and `plan` deny them.
 */
export async function runHeadless(options: HeadlessOptions): Promise<number> {
  const {
    config,
    root,
    mode,
    prompt,
    provider,
    instructions,
    showReasoning,
    out,
    err,
    signal,
    session,
    resumed,
  } = options;

  if (instructions.sources.length > 0) {
    err.write(
      `instructions: ${describeInstructions(instructions.sources, root)}\n`,
    );
  }

  if (mode === "ask") {
    err.write(
      "ask mode has no interactive approver in --print: writes and commands will be denied.\n" +
        "Pass --mode auto to let Cooper change files and run commands.\n",
    );
  } else if (mode === "plan") {
    err.write("plan mode: writes and commands will be denied.\n");
  }

  // Nobody can answer an approval prompt here. The non-interactive policy
  // turns ask into a denial instead of relying on a dummy approve callback.
  const permissions = new PermissionPolicy({
    preset: mode,
    interactive: false,
  });

  let sessionWarned = false;
  const warnSession = (error: Error | null) => {
    if (error === null || sessionWarned) return;
    sessionWarned = true;
    err.write(`session not saved: ${error.message}\n`);
  };

  if (resumed) {
    err.write(
      `resumed session ${resumed.header.id} (${resumed.messages.length} message(s))\n`,
    );
    if (resumed.repaired > 0) {
      err.write(`repaired ${resumed.repaired} invalid session row(s)\n`);
    }
  } else if (session) {
    err.write(
      `session ${session.id} · resume with: cooper --resume ${session.id}\n`,
    );
  }

  // The system prompt is regenerated, never restored: mode, cwd, and project
  // instructions may all have changed since the session was saved.
  const userMessage: Message = { role: "user", content: prompt };
  if (session) warnSession(session.appendMessage(userMessage));

  const messages: Message[] = [
    {
      role: "system",
      content: buildSystemPrompt({
        root,
        permissions,
        instructions: instructions.text,
      }),
    },
    ...(resumed?.messages ?? []),
    userMessage,
  ];

  let atLineStart = true;
  let wroteText = false;
  let sawDelta = false;

  // Reasoning is display-only and never enters the conversation history.
  // It streams to stderr in real time: buffering to completed lines would
  // reorder short, newline-free reasoning until after the answer.
  let reasoningOpen = false;
  let reasoningLineStart = true;

  const writeReasoning = (delta: string) => {
    if (!reasoningOpen) {
      endTextLine();
      reasoningOpen = true;
      reasoningLineStart = true;
    }
    const parts = delta.split("\n");
    for (let index = 0; index < parts.length; index += 1) {
      if (reasoningLineStart) {
        err.write("⋯ ");
        reasoningLineStart = false;
      }
      err.write(parts[index] ?? "");
      if (index < parts.length - 1) {
        err.write("\n");
        reasoningLineStart = true;
      }
    }
  };

  const closeReasoning = () => {
    if (!reasoningOpen) return;
    if (!reasoningLineStart) err.write("\n");
    reasoningOpen = false;
  };

  const writeText = (delta: string) => {
    if (delta.length === 0) return;
    out.write(delta);
    wroteText = true;
    atLineStart = delta.endsWith("\n");
  };

  // Progress goes to stderr, but it must not visually collide with answer
  // text already in flight on stdout.
  const endTextLine = () => {
    if (!atLineStart) {
      out.write("\n");
      atLineStart = true;
    }
  };

  try {
    for await (const event of runAgent({
      provider,
      model: config.model,
      tools: allTools,
      messages,
      context: { root },
      permissions,
      contextBudget: config.context,
      signal,
    })) {
      switch (event.type) {
        case "turn-start": {
          sawDelta = false;
          break;
        }

        case "text-delta": {
          // Reasoning for this turn is over once the answer starts.
          closeReasoning();
          sawDelta = true;
          writeText(event.delta);
          break;
        }

        case "reasoning-delta": {
          if (showReasoning) writeReasoning(event.delta);
          break;
        }

        case "assistant-done": {
          closeReasoning();
          // Some providers report text only in the completion, with no deltas.
          if (!sawDelta) writeText(event.content);
          break;
        }

        case "tool-start": {
          endTextLine();
          err.write(`→ ${event.call.name} ${oneLine(event.summary)}\n`);
          break;
        }

        case "tool-end": {
          endTextLine();
          const icon = event.denied
            ? ICONS.denied
            : event.isError
              ? ICONS.error
              : ICONS.ok;
          err.write(`  ${icon} ${event.durationMs}ms\n`);
          break;
        }

        case "context-compacted": {
          endTextLine();
          err.write(
            `⤓ context ${formatTokens(event.before)} → ${formatTokens(event.after)} tokens (${event.action})\n`,
          );
          break;
        }

        case "max-turns": {
          endTextLine();
          err.write(`Stopped after ${event.turns} turns without finishing.\n`);
          return 1;
        }
      }

      // Reasoning and text deltas are display-only; the durable assistant
      // message and tool results arrive as whole events.
      if (
        event.type === "assistant-done" ||
        event.type === "tool-end" ||
        event.type === "context-compacted"
      ) {
        warnSession(session?.recordEvent(event, messages) ?? null);
      }
    }
  } catch (error) {
    closeReasoning();
    endTextLine();
    if (signal?.aborted) {
      err.write("Interrupted.\n");
      return 130;
    }
    err.write(
      `Error: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }

  if (wroteText && !atLineStart) out.write("\n");
  return 0;
}
