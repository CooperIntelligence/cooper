import React, { useRef, useState } from "react";
import { Box, Static, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import Spinner from "ink-spinner";
import {
  allTools,
  OpenAICompatibleProvider,
  runAgent,
  type ApprovalDecision,
  type ApprovalRequest,
  type Message,
} from "@cooper/core";
import type { ApprovalMode, Config } from "./config.js";
import { splitCompletedLines, splitContent } from "./stream-lines.js";

type ToolStatus = "running" | "ok" | "error" | "denied";

type UiItem =
  | { id: number; kind: "user"; text: string }
  | { id: number; kind: "assistant-line"; text: string; first: boolean }
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

function truncate(text: string, max: number): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine.length > max ? `${singleLine.slice(0, max - 1)}…` : singleLine;
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

function ApprovalPanel({ request }: { request: ApprovalRequest }) {
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
      <Text dimColor>
        y allow once · a always allow {request.toolName} · n / esc deny
      </Text>
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
}: {
  config: Config;
  root: string;
  mode: ApprovalMode;
}) {
  const { exit } = useApp();
  const [provider] = useState(
    () =>
      new OpenAICompatibleProvider({
        apiKey: config.apiKey,
        baseURL: config.baseURL,
      }),
  );
  const permissionLine =
    mode === "plan"
      ? "You are in plan mode: you may inspect files, but do not modify files or run commands. Produce a plan for the user to approve."
      : "You may inspect files, edit files, and run shell commands. Tools that change the workspace or execute commands require user approval.";
  const history = useRef<Message[]>([
    {
      role: "system",
      content: [
        `You are Cooper, a terminal coding agent working in the project at ${root}.`,
        permissionLine,
        "Prefer read_file/grep over guessing, and edit_file over write_file for targeted changes.",
        "Keep changes minimal and verify your work by running tests when appropriate.",
        "Be concise and reply in the same language as the user.",
      ].join("\n"),
    },
  ]);
  const abortRef = useRef<AbortController | null>(null);
  const busyRef = useRef(false);
  const nextId = useRef(1);

  const approvalResolver = useRef<((decision: ApprovalDecision) => void) | null>(
    null,
  );
  const approvalRequest = useRef<ApprovalRequest | null>(null);
  const allowedTools = useRef(new Set<string>());

  const [pendingApproval, setPendingApproval] = useState<ApprovalRequest | null>(
    null,
  );
  const [committed, setCommitted] = useState<UiItem[]>([
    {
      id: 0,
      kind: "notice",
      tone: "info",
      text:
        `Cooper ready · ${config.model} · ${root}\n` +
        `Mode: ${mode}${mode === "auto" ? " (auto-approve ALL tools)" : ""} · tools: list_dir, read_file, grep, write_file, edit_file, run_command. Esc interrupts.`,
    },
  ]);
  const [live, setLive] = useState<UiItem | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);

  const resolveApproval = (decision: ApprovalDecision) => {
    const resolver = approvalResolver.current;
    approvalResolver.current = null;
    approvalRequest.current = null;
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
        const request = approvalRequest.current;
        if (request) allowedTools.current.add(request.toolName);
        resolveApproval("allow");
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
    const text = value.trim();
    if (!text || busyRef.current) return;

    // Guards against a second submit landing before React re-renders and
    // unmounts the input (e.g. Enter key repeat).
    busyRef.current = true;

    const push = (item: UiItem) =>
      setCommitted((previous) => [...previous, item]);

    setInput("");
    setBusy(true);
    push({ id: nextId.current++, kind: "user", text });
    history.current.push({ role: "user", content: text });

    const controller = new AbortController();
    abortRef.current = controller;

    let lineBuffer = "";
    let lineStarted = false;
    let liveLineId: number | null = null;
    let sawText = false;

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

    try {
      for await (const event of runAgent({
        provider,
        model: config.model,
        tools: allTools,
        messages: history.current,
        context: { root },
        signal: controller.signal,
        approve: (request) => {
          if (mode === "auto") return "allow";
          if (mode === "plan") return "deny";
          if (allowedTools.current.has(request.toolName)) return "allow";

          return new Promise<ApprovalDecision>((resolve) => {
            approvalResolver.current = resolve;
            approvalRequest.current = request;
            setPendingApproval(request);
          });
        },
      })) {
        switch (event.type) {
          case "turn-start":
            break;

          case "text-delta":
            appendText(event.delta);
            break;

          case "assistant-done":
            flushText(event.content);
            break;

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

          case "max-turns":
            push({
              id: nextId.current++,
              kind: "notice",
              tone: "error",
              text: `Stopped after ${event.turns} turns.`,
            });
            break;
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
    }
  };

  return (
    <Box flexDirection="column">
      <Static items={committed} style={{ width: "100%" }}>
        {(item) => <ItemRow key={item.id} item={item} />}
      </Static>

      {live ? <ItemRow item={live} /> : null}
      {pendingApproval ? <ApprovalPanel request={pendingApproval} /> : null}

      <Box marginTop={1}>
        {busy ? (
          <Text>
            <Text color="yellow">
              <Spinner type="dots" />
            </Text>
            <Text dimColor>{"  working — esc to interrupt"}</Text>
          </Text>
        ) : (
          <Box>
            <Text color="cyan">{"> "}</Text>
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
