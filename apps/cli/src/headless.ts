import {
  allTools,
  runAgent,
  type Message,
  type Provider,
} from "@cooper/core";
import type { ApprovalMode, Config } from "./config.js";
import { buildSystemPrompt } from "./system-prompt.js";

/** Minimal sink so tests can capture output without real streams. */
export type Writer = { write(chunk: string): unknown };

export type HeadlessOptions = {
  config: Config;
  root: string;
  mode: ApprovalMode;
  prompt: string;
  provider: Provider;
  /** Assistant text. Kept clean so it can be piped or redirected. */
  out: Writer;
  /** Tool activity, warnings, and errors. */
  err: Writer;
  signal?: AbortSignal;
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
  const { config, root, mode, prompt, provider, out, err, signal } = options;

  if (mode === "ask") {
    err.write(
      "ask mode has no interactive approver in --print: writes and commands will be denied.\n" +
        "Pass --mode auto to let Cooper change files and run commands.\n",
    );
  } else if (mode === "plan") {
    err.write("plan mode: writes and commands will be denied.\n");
  }

  const messages: Message[] = [
    {
      role: "system",
      content: buildSystemPrompt({ root, mode, interactive: false }),
    },
    { role: "user", content: prompt },
  ];

  let atLineStart = true;
  let wroteText = false;
  let sawDelta = false;

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
      contextBudget: config.context,
      signal,
      approve: () => (mode === "auto" ? "allow" : "deny"),
    })) {
      switch (event.type) {
        case "turn-start": {
          sawDelta = false;
          break;
        }

        case "text-delta": {
          sawDelta = true;
          writeText(event.delta);
          break;
        }

        case "assistant-done": {
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
    }
  } catch (error) {
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
