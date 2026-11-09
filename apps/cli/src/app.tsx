import React, { useEffect, useRef, useState } from "react";
import { Box, Static, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import Spinner from "ink-spinner";
import {
  PermissionPolicy,
  permissionModeNotice,
  runAgent,
  type ApprovalOutcome,
  type ApprovalRequest,
  type LoadedInstructions,
  type LoadedSession,
  type Message,
  type Provider,
  type SessionWriter,
  type Tool,
} from "@cooper/core";
import {
  commandHelp,
  isModeCommand,
  modeDescription,
  parseCommand,
  type ParsedCommand,
} from "./commands.js";
import { buildPreviewRows } from "./preview.js";
import type { ApprovalMode, Config } from "./config.js";
import type { McpReport } from "./mcp.js";
import { buildResumeView } from "./session-view.js";
import { splitCompletedLines, splitContent } from "./stream-lines.js";
import { buildSystemPrompt, describeInstructions } from "./system-prompt.js";
import type { UiItem } from "./ui-types.js";

function truncate(text: string, max: number): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine.length > max ? `${singleLine.slice(0, max - 1)}…` : singleLine;
}

function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}

function formatCount(count: number): string {
  return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count);
}

function previewLines(text: string, maxLines = 6): string[] {
  const lines = text.split(/\r?\n/);
  const shown = lines.slice(0, maxLines).map((line) => truncate(line, 160));
  if (lines.length > maxLines) {
    shown.push(`… ${lines.length - maxLines} more line(s)`);
  }
  return shown;
}

function ItemRow({ item }: { item: UiItem }) {
  if (item.kind === "user") {
    return (
      <Box marginTop={1}>
        <Text color="cyan" bold>
          {"❯ "}
        </Text>
        <Text wrap="wrap">{item.text}</Text>
      </Box>
    );
  }

  if (item.kind === "assistant-line") {
    return (
      <Box flexDirection="column" marginTop={item.first ? 1 : 0}>
        {item.first ? (
          <Text color="green" bold>
            Cooper
          </Text>
        ) : null}
        <Text wrap="wrap">{item.text.length > 0 ? item.text : " "}</Text>
      </Box>
    );
  }

  if (item.kind === "reasoning-line") {
    return (
      <Box>
        <Text color="gray" dimColor wrap="wrap">
          {`· ${item.text}`}
        </Text>
      </Box>
    );
  }

  if (item.kind === "notice") {
    return (
      <Box marginTop={1}>
        <Text color={item.tone === "error" ? "red" : "gray"} wrap="wrap">
          {item.text}
        </Text>
      </Box>
    );
  }

  const icon =
    item.status === "running" ? (
      <Spinner type="dots" />
    ) : item.status === "denied" ? (
      <Text color="yellow">⊘</Text>
    ) : item.status === "error" ? (
      <Text color="red">✗</Text>
    ) : (
      <Text color="green">✓</Text>
    );

  const headline = item.summary.split(/\r?\n/)[0] ?? item.summary;

  return (
    <Box marginTop={1} flexDirection="column">
      <Box>
        <Box marginRight={1}>{icon}</Box>
        <Text color="magenta">{item.name}</Text>
        <Text dimColor> {truncate(headline, 120)}</Text>
        {item.durationMs !== undefined ? (
          <Text dimColor>
            {"  "}
            {item.durationMs}ms
          </Text>
        ) : null}
      </Box>
      {item.output ? (
        <Box marginLeft={2} flexDirection="column">
          {previewLines(item.output).map((line, index) => (
            <Text key={index} dimColor wrap="truncate-end">
              {line}
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}

export function ApprovalPanel({ request }: { request: ApprovalRequest }) {
  const preview = request.preview;
  const diff = preview?.kind === "diff" ? buildPreviewRows(preview) : null;

  return (
    <Box
      marginTop={1}
      flexDirection="column"
      borderStyle="round"
      borderColor="yellow"
      paddingX={1}
    >
      <Text bold color="yellow">
        Approve {request.toolName}?
      </Text>
      <Text wrap="wrap">{request.summary}</Text>

      {preview?.kind === "diff" && diff !== null ? (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>
            {preview.path} · +{diff.added} −{diff.removed}
          </Text>
          {diff.rows.length > 0 ? (
            diff.rows.map((row, index) => (
              <Text
                key={index}
                color={
                  row.tone === "add"
                    ? "green"
                    : row.tone === "remove"
                      ? "red"
                      : row.tone === "hunk"
                        ? "cyan"
                        : "gray"
                }
                wrap="truncate-end"
              >
                {row.text}
              </Text>
            ))
          ) : (
            <Text dimColor>No changes.</Text>
          )}
          {diff.hidden > 0 ? (
            <Text dimColor>… {diff.hidden} more line(s)</Text>
          ) : null}
        </Box>
      ) : null}

      <Box marginTop={1}>
        <Text dimColor>
          y allow once · a always allow {request.toolName} · n / esc deny
        </Text>
      </Box>
    </Box>
  );
}

/**
 * While a message streams, complete lines are committed to <Static> exactly
 * once and therefore scroll naturally into history. Only the unfinished
 * trailing line lives in the dynamic region. This keeps the dynamic frame
 * a couple of rows tall, which is what prevents Ink from taking its Windows
 * fullscreen-clear path and stamping duplicated copies into scrollback.
 */
export function App({
  config,
  root,
  mode,
  instructions,
  showReasoning,
  provider,
  tools,
  mcp,
  modeNotice,
  session,
  resumed,
}: {
  config: Config;
  root: string;
  mode: ApprovalMode;
  instructions: LoadedInstructions;
  showReasoning: boolean;
  /** Built once by the entry point so every surface uses the same adapter. */
  provider: Provider;
  /** Built-in tools plus any connected MCP tools. */
  tools: Tool[];
  /** MCP startup status, shown in the banner and as notices. */
  mcp: McpReport;
  /** Restored/refused mode information, when resuming a session. */
  modeNotice?: string;
  /** Writes this conversation; null with `--no-session`. */
  session: SessionWriter | null;
  /** Previously saved conversation to restore, if `--resume` was used. */
  resumed: LoadedSession | null;
}) {
  const { exit } = useApp();
  // The TUI is interactive by definition; the policy is the single source of
  // the permission decisions. Its preset changes at runtime, but the system
  // prompt deliberately stays mode-neutral.
  const [permissions] = useState(
    () => new PermissionPolicy({ preset: mode, interactive: true }),
  );
  const [modeState, setModeState] = useState<ApprovalMode>(mode);
  const history = useRef<Message[]>([
    {
      role: "system",
      content: buildSystemPrompt({
        root,
        permissions,
        instructions: instructions.text,
      }),
    },
    ...(resumed?.messages ?? []),
    permissionModeNotice(mode),
  ]);
  const abortRef = useRef<AbortController | null>(null);
  const busyRef = useRef(false);
  const sessionFailureShown = useRef(false);

  const approvalResolver = useRef<((decision: ApprovalOutcome) => void) | null>(
    null,
  );

  const [pendingApproval, setPendingApproval] = useState<ApprovalRequest | null>(
    null,
  );
  const sessionLine =
    resumed !== null
      ? `Resumed session ${resumed.header.id} · ${resumed.messages.length} message(s)` +
        (resumed.repaired > 0
          ? ` · repaired ${resumed.repaired} invalid row(s)`
          : "")
      : session !== null
        ? `Session ${session.id} · resume with: cooper --resume ${session.id}`
        : "Session: not saved (--no-session)";

  // Replayed history and the banner are committed once, before the live
  // region exists, so resumed rows scroll into history exactly like live ones.
  const [initial] = useState(() => {
    // Server tools are `mcp__<server>__<tool>`; Cooper's shared resource
    // tools are `mcp_*`, so both belong in the MCP count.
    const mcpToolCount = tools.filter((tool) =>
      tool.name.startsWith("mcp_"),
    ).length;
    const toolLine = `Tools: ${tools.length}${mcpToolCount > 0 ? ` (${mcpToolCount} MCP)` : ""}`;
    const mcpLine =
      mcp.statuses.length === 0
        ? mcp.warnings.length > 0
          ? "MCP: no servers loaded"
          : "MCP: none"
        : `MCP: ${mcp.statuses
            .map((status) =>
              status.ok
                ? `${status.name} (${status.toolCount})`
                : `${status.name} failed`,
            )
            .join(", ")}`;

    const banner: UiItem = {
      id: 0,
      kind: "notice",
      tone: "info",
      text:
        `Cooper ready · ${config.model} · ${root}\n` +
        `Mode: ${permissions.preset}${permissions.preset === "auto" ? " (auto-approve ALL tools)" : ""} · ${toolLine}. /plan /ask /auto switch modes. Esc interrupts.\n` +
        `Context: ${formatTokens(config.context.window)}${config.contextWindowAssumed ? " (assumed — set COOPER_CONTEXT_WINDOW to override)" : ""} · prunes at 65%, summarizes at 80%\n` +
        `Instructions: ${describeInstructions(instructions.sources, root)}\n` +
        `${mcpLine}\n` +
        sessionLine,
    };

    let id = 1;
    const startup: UiItem[] = [];
    for (const warning of mcp.warnings) {
      startup.push({
        id: id++,
        kind: "notice",
        tone: "info",
        text: `MCP: ${warning}`,
      });
    }
    for (const status of mcp.statuses) {
      if (status.ok) continue;
      startup.push({
        id: id++,
        kind: "notice",
        tone: "error",
        text: `MCP server ${status.name} failed: ${status.error ?? "unknown error"}`,
      });
    }
    if (modeNotice !== undefined) {
      startup.push({
        id: id++,
        kind: "notice",
        tone: "info",
        text: `Mode: ${modeNotice}`,
      });
    }

    const view =
      resumed !== null
        ? buildResumeView(resumed, id)
        : { items: [] as UiItem[], nextId: id };
    return { items: [banner, ...startup, ...view.items], nextId: view.nextId };
  });
  const [committed, setCommitted] = useState<UiItem[]>(initial.items);
  const nextId = useRef(initial.nextId);
  const [live, setLive] = useState<UiItem | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [reasoningHint, setReasoningHint] = useState<string | null>(null);
  // Tail of the reasoning line that has not been committed yet.
  const [liveReasoning, setLiveReasoning] = useState<string | null>(null);

  const pushCommitted = (item: UiItem) => {
    setCommitted((previous) => [...previous, item]);
  };

  // A failed session write must never take down the conversation; tell the
  // user once and keep working.
  const warnSession = (error: Error | null) => {
    if (error === null || sessionFailureShown.current) return;
    sessionFailureShown.current = true;
    pushCommitted({
      id: nextId.current++,
      kind: "notice",
      tone: "error",
      text: `Session not saved: ${error.message}`,
    });
  };

  const switchMode = (next: ApprovalMode) => {
    if (busyRef.current) {
      pushCommitted({
        id: nextId.current++,
        kind: "notice",
        tone: "info",
        text: "Wait for the current turn to finish (or press Esc) before switching modes.",
      });
      return;
    }
    if (permissions.preset === next) {
      pushCommitted({
        id: nextId.current++,
        kind: "notice",
        tone: "info",
        text: `Already in ${modeDescription(next)} mode.`,
      });
      return;
    }

    permissions.setPreset(next);
    setModeState(next);
    const notice = permissionModeNotice(next);
    history.current.push(notice);
    warnSession(session?.appendPolicy(next) ?? null);
    warnSession(session?.appendMessage(notice) ?? null);
    pushCommitted({
      id: nextId.current++,
      kind: "notice",
      tone: next === "auto" ? "error" : "info",
      text: `Mode: ${modeDescription(next)}`,
    });
  };

  const handleCommand = (command: ParsedCommand) => {
    if (command.kind === "unknown") {
      const shown = command.name.length > 0 ? ` /${command.name}` : " /";
      pushCommitted({
        id: nextId.current++,
        kind: "notice",
        tone: "error",
        text: `Unknown command${shown}. Type /help to list commands.`,
      });
      return;
    }
    if (command.kind !== "command") return;

    if (command.name === "help") {
      pushCommitted({
        id: nextId.current++,
        kind: "notice",
        tone: "info",
        text: commandHelp(modeState),
      });
      return;
    }
    if (isModeCommand(command.name)) {
      switchMode(command.name);
    }
  };

  // Record the mode that this process actually starts with. The notice is
  // appended after any resumed history; it never rewrites the system prompt.
  useEffect(() => {
    if (session === null) return;
    warnSession(session.appendPolicy(mode));
    warnSession(session.appendMessage(permissionModeNotice(mode)));
    // `mode` is the startup mode; runtime changes are recorded by switchMode.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const resolveApproval = (decision: ApprovalOutcome) => {
    const resolver = approvalResolver.current;
    approvalResolver.current = null;
    setPendingApproval(null);
    resolver?.(decision);
  };

  useInput((inputChar, key) => {
    if (approvalResolver.current) {
      if (key.ctrl && inputChar === "c") {
        abortRef.current?.abort();
        resolveApproval("deny");
        return;
      }
      if (key.escape) {
        resolveApproval("deny");
        return;
      }
      const choice = inputChar.toLowerCase();
      if (choice === "y") {
        resolveApproval("allow");
      } else if (choice === "n") {
        resolveApproval("deny");
      } else if (choice === "a") {
        resolveApproval("allow-session");
      }
      return;
    }

    if (key.ctrl && inputChar === "c") {
      if (abortRef.current) {
        abortRef.current.abort();
      } else {
        exit();
      }
      return;
    }
    if (key.escape && abortRef.current) {
      abortRef.current.abort();
    }
  });

  const submit = async (value: string) => {
    const parsed = parseCommand(value);
    if (parsed.kind !== "prompt") {
      setInput("");
      if (busyRef.current) {
        pushCommitted({
          id: nextId.current++,
          kind: "notice",
          tone: "info",
          text: "Wait for the current turn to finish (or press Esc) before using commands.",
        });
        return;
      }
      handleCommand(parsed);
      return;
    }

    const text = parsed.text.trim();
    if (!text || busyRef.current) return;

    // Guards against a second submit landing before React re-renders and
    // unmounts the input (e.g. Enter key repeat).
    busyRef.current = true;

    const push = pushCommitted;

    setInput("");
    setBusy(true);
    push({ id: nextId.current++, kind: "user", text });
    history.current.push({ role: "user", content: text });
    warnSession(
      session?.appendMessage({ role: "user", content: text }) ?? null,
    );

    const controller = new AbortController();
    abortRef.current = controller;

    let lineBuffer = "";
    let lineStarted = false;
    let liveLineId: number | null = null;
    let sawText = false;

    // Reasoning is display-only: it never enters the conversation history.
    let reasoningBuffer = "";
    let reasoningChars = 0;
    let lastHintAt = 0;

    const commitLine = (line: string) => {
      push({
        id: nextId.current++,
        kind: "assistant-line",
        text: line,
        first: !lineStarted,
      });
      lineStarted = true;
    };

    const showLiveLine = () => {
      if (lineBuffer.length === 0) {
        if (liveLineId !== null) {
          setLive(null);
          liveLineId = null;
        }
        return;
      }
      if (liveLineId === null) liveLineId = nextId.current++;
      // A single unterminated line can still be arbitrarily long; cap the
      // live preview so the dynamic frame never grows tall.
      const preview =
        lineBuffer.length > 240 ? `…${lineBuffer.slice(-240)}` : lineBuffer;
      setLive({
        id: liveLineId,
        kind: "assistant-line",
        text: preview,
        first: !lineStarted,
      });
    };

    const appendText = (delta: string) => {
      sawText = true;
      const split = splitCompletedLines(lineBuffer, delta);
      lineBuffer = split.buffer;
      for (const line of split.lines) commitLine(line);
      showLiveLine();
    };

    const flushText = (content: string) => {
      if (lineBuffer.length > 0) {
        const remaining = lineBuffer;
        lineBuffer = "";
        commitLine(remaining);
      }

      // Some providers may deliver the final text only in the completion
      // (no text deltas). Fall back to the authoritative content.
      if (!sawText && content.trim().length > 0) {
        for (const line of splitContent(content)) commitLine(line);
      }

      setLive(null);
      liveLineId = null;
      lineStarted = false;
      sawText = false;
    };

    const showLiveReasoning = () => {
      if (!showReasoning || reasoningBuffer.length === 0) {
        setLiveReasoning(null);
        return;
      }
      // The live region stays one row; the full line is committed on flush.
      const preview =
        reasoningBuffer.length > 240
          ? `…${reasoningBuffer.slice(-240)}`
          : reasoningBuffer;
      setLiveReasoning(preview);
    };

    const flushReasoning = () => {
      if (!showReasoning) return;
      if (reasoningBuffer.length > 0) {
        push({
          id: nextId.current++,
          kind: "reasoning-line",
          text: reasoningBuffer,
        });
        reasoningBuffer = "";
      }
      setLiveReasoning(null);
    };

    const handleReasoning = (delta: string) => {
      reasoningChars += delta.length;

      if (showReasoning) {
        const split = splitCompletedLines(reasoningBuffer, delta);
        reasoningBuffer = split.buffer;
        for (const line of split.lines) {
          push({ id: nextId.current++, kind: "reasoning-line", text: line });
        }
        showLiveReasoning();
      }

      // Throttle: reasoning arrives in many small deltas.
      const now = Date.now();
      if (now - lastHintAt >= 120) {
        lastHintAt = now;
        setReasoningHint(`reasoning ${formatCount(reasoningChars)} chars`);
      }
    };

    try {
      for await (const event of runAgent({
        provider,
        model: config.model,
        tools,
        messages: history.current,
        context: { root },
        permissions,
        contextBudget: config.context,
        signal: controller.signal,
        approve: (request) =>
          new Promise<ApprovalOutcome>((resolve) => {
            approvalResolver.current = resolve;
            setPendingApproval(request);
          }),
      })) {
        switch (event.type) {
          case "turn-start":
            break;

          case "text-delta":
            // Any pending reasoning belongs before the answer, not after it.
            flushReasoning();
            appendText(event.delta);
            break;

          case "reasoning-delta":
            handleReasoning(event.delta);
            break;

          case "assistant-done": {
            flushReasoning();

            const reasoningTokens = event.usage?.reasoningTokens;
            if (
              !showReasoning &&
              reasoningTokens !== undefined &&
              reasoningTokens > 0
            ) {
              push({
                id: nextId.current++,
                kind: "reasoning-line",
                text: `reasoned ${formatTokens(reasoningTokens)} tokens`,
              });
            }

            flushText(event.content);
            setReasoningHint(null);
            break;
          }

          case "tool-start": {
            const toolItemId = nextId.current++;
            setLive({
              id: toolItemId,
              kind: "tool",
              name: event.call.name,
              summary: event.summary,
              status: "running",
            });
            break;
          }

          case "tool-end": {
            setLive(null);
            push({
              id: nextId.current++,
              kind: "tool",
              name: event.call.name,
              summary: event.summary,
              status: event.denied
                ? "denied"
                : event.isError
                  ? "error"
                  : "ok",
              output: event.result.content,
              durationMs: event.durationMs,
            });
            break;
          }

          case "context-compacted":
            push({
              id: nextId.current++,
              kind: "notice",
              tone: "info",
              text: `⤓ context ${formatTokens(event.before)} → ${formatTokens(event.after)} tokens (${event.action})`,
            });
            break;

          case "max-turns":
            push({
              id: nextId.current++,
              kind: "notice",
              tone: "error",
              text: `Stopped after ${event.turns} turns.`,
            });
            break;
        }

        // Persist only messages (and compaction snapshots); text/reasoning
        // deltas are ephemeral and never enter the conversation history.
        if (
          event.type === "assistant-done" ||
          event.type === "tool-end" ||
          event.type === "context-compacted"
        ) {
          warnSession(session?.recordEvent(event, history.current) ?? null);
        }
      }
    } catch (error) {
      resolveApproval("deny");
      setLive(null);
      if (controller.signal.aborted) {
        if (lineBuffer.trim().length > 0) {
          commitLine(lineBuffer);
        }
        push({
          id: nextId.current++,
          kind: "notice",
          tone: "info",
          text: "Interrupted.",
        });
      } else {
        push({
          id: nextId.current++,
          kind: "notice",
          tone: "error",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    } finally {
      abortRef.current = null;
      busyRef.current = false;
      setBusy(false);
      setReasoningHint(null);
      setLiveReasoning(null);
    }
  };

  return (
    <Box flexDirection="column">
      <Static items={committed} style={{ width: "100%" }}>
        {(item) => <ItemRow key={item.id} item={item} />}
      </Static>

      {liveReasoning !== null ? (
        <Box>
          <Text color="gray" dimColor wrap="truncate-end">
            {`· ${liveReasoning}`}
          </Text>
        </Box>
      ) : null}

      {live ? <ItemRow item={live} /> : null}
      {pendingApproval ? <ApprovalPanel request={pendingApproval} /> : null}

      <Box marginTop={1}>
        {busy ? (
          <Text>
            <Text color="yellow">
              <Spinner type="dots" />
            </Text>
            <Text dimColor>
              {`  ${reasoningHint ?? "working"} · ${modeState} · esc to interrupt`}
            </Text>
          </Text>
        ) : (
          <Box>
            <Text color={modeState === "auto" ? "yellow" : "cyan"}>
              {`${modeState} > `}
            </Text>
            <TextInput
              value={input}
              onChange={setInput}
              onSubmit={(value) => {
                void submit(value);
              }}
              placeholder="Ask Cooper to inspect or change the project…"
            />
          </Box>
        )}
      </Box>
    </Box>
  );
}
