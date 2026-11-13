import path from "node:path";
import React, { useEffect, useRef, useState } from "react";
import { Box, Static, Text, useApp, useInput, type RenderOptions } from "ink";
import TextInput from "ink-text-input";
import Spinner from "ink-spinner";
import {
  PermissionPolicy,
  SessionWriter,
  createRunCommandTool,
  estimateContextTokens,
  listSessions,
  permissionModeNotice,
  prepareContext,
  resolveContextConfig,
  resumeSession,
  runAgent,
  sessionsDir,
  toToolSpec,
  type ApprovalOutcome,
  type ApprovalRequest,
  type LoadedInstructions,
  type LoadedSession,
  type Message,
  type Provider,
  type Tool,
} from "@cooper/core";
import {
  commandHelp,
  completeCommand,
  filterCommands,
  formatMcp,
  formatSessions,
  formatStatus,
  formatTools,
  isModeCommand,
  modeDescription,
  parseCommand,
  type ParsedCommand,
} from "./commands.js";
import { ApprovalPanel } from "./approval.js";
import { visiblePreviewText } from "./preview.js";
import { createMarkdownFormatter, type MarkdownLine } from "./markdown.js";
import type { ModeResolution } from "./args.js";
import { loadConfig, resolveConfig, type ApprovalMode, type Config } from "./config.js";
import { ConfigEditor, configFieldIndex } from "./config-editor.js";
import type { McpReport } from "./mcp.js";
import { createProvider } from "./provider.js";
import { buildResumeView } from "./session-view.js";
import { parseSettings, readSettingsDocument, writeSettingsDocument, type SettingsDocument } from "./settings.js";
import { splitCompletedLines, splitContent } from "./stream-lines.js";
import { buildSystemPrompt, describeInstructions } from "./system-prompt.js";
import type { UiItem } from "./ui-types.js";

export const tuiRenderOptions = {
  exitOnCtrlC: false,
  // Leave unchanged prompt cells in place instead of erasing the input frame.
  incrementalRendering: process.platform === "win32",
} satisfies RenderOptions;

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

/** plan green · ask cyan · auto yellow — the prompt prefix is the mode HUD. */
function modePromptColor(mode: ApprovalMode): string {
  if (mode === "plan") return "green";
  if (mode === "auto") return "yellow";
  return "cyan";
}

function previewLines(text: string, maxLines = 6): string[] {
  const lines = text.split(/\r?\n/);
  const shown = lines.slice(0, maxLines).map((line) => truncate(line, 160));
  if (lines.length > maxLines) {
    shown.push(`… ${lines.length - maxLines} more line(s)`);
  }
  return shown;
}

function ReplyLine({ line, live }: { line: MarkdownLine; live: boolean }) {
  if (line.kind === "code-label") {
    return <Text dimColor wrap="truncate-end">{line.text}</Text>;
  }
  if (line.kind === "code") {
    return <Text>{line.text || " "}</Text>;
  }

  const text = (
    <Text
      bold={line.kind === "heading"}
      color={line.kind === "heading" ? "cyan" : undefined}
      wrap={live ? "truncate-end" : "wrap"}
    >
      {line.spans.length === 0
        ? " "
        : line.spans.map((span, index) => (
            <Text
              key={index}
              bold={span.bold}
              italic={span.italic}
              color={span.code ? "cyan" : undefined}
            >
              {span.text}
            </Text>
          ))}
    </Text>
  );
  if (line.kind !== "list") return text;
  return (
    <Box>
      <Text>{line.prefix}</Text>
      <Box flexShrink={1}>{text}</Box>
    </Box>
  );
}

function ItemRow({ item, live = false }: { item: UiItem; live?: boolean }) {
  if (item.kind === "header") {
    return (
      <Box flexDirection="column">
        <Box>
          <Text bold>
            C<Text color="#56DCC8">OO</Text>PER
          </Text>
          <Text dimColor wrap="truncate-end">{`  ${item.model}`}</Text>
        </Box>
        <Text dimColor wrap="truncate-middle">{item.root}</Text>
        {item.autoApprove && <Text color="yellow">Auto mode approves all tool calls.</Text>}
        {item.resume && <Text dimColor>{item.resume}</Text>}
      </Box>
    );
  }

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
        <ReplyLine line={item.line} live={live} />
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
        {item.processGrant ? <Text dimColor> · process grant</Text> : null}
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

/**
 * While a message streams, complete lines are committed to <Static> exactly
 * once and therefore scroll naturally into history. Only the unfinished
 * trailing line lives in the dynamic region. This keeps the dynamic frame
 * a couple of rows tall, which is what prevents Ink from taking its Windows
 * fullscreen-clear path and stamping duplicated copies into scrollback.
 */
export function App({
  config: initialConfig,
  root,
  mode,
  modeSource,
  instructions,
  showReasoningFlag,
  provider: initialProvider,
  tools: initialTools,
  mcp,
  modeNotice,
  session,
  resumed,
}: {
  config: Config;
  root: string;
  mode: ApprovalMode;
  /** Where the startup mode came from (flag/env/session/config/default). */
  modeSource: ModeResolution["source"];
  instructions: LoadedInstructions;
  showReasoningFlag: boolean;
  /** Provider created by the entry point from the initial configuration. */
  provider: Provider;
  /** Built-in tools plus any connected MCP tools. */
  tools: Tool[];
  /** MCP status for /mcp and startup notices. */
  mcp: McpReport;
  /** Restored/refused mode information, when resuming a session. */
  modeNotice?: string;
  /** Writes this conversation; null with `--no-session`. */
  session: SessionWriter | null;
  /** Previously saved conversation to restore, if `--resume` was used. */
  resumed: LoadedSession | null;
}) {
  const { exit } = useApp();
  const active = useRef({
    config: initialConfig,
    provider: initialProvider,
    tools: initialTools,
  });
  const [configEdit, setConfigEdit] = useState<{ document: SettingsDocument; field: number } | null>(null);
  // The TUI is interactive by definition; the policy is the single source of
  // the permission decisions. Its preset changes at runtime, but the system
  // prompt deliberately stays mode-neutral.
  const [permissions] = useState(
    () => new PermissionPolicy({ preset: mode, interactive: true }),
  );
  const [modeState, setModeState] = useState<ApprovalMode>(mode);
  // Tracked separately so /status can say where the current mode came from;
  // in-session switches count as "command".
  const [modeSourceState, setModeSourceState] = useState<
    ModeResolution["source"] | "command"
  >(modeSource);
  // Mutable so /clear can swap in a fresh SessionWriter; `sessionsEnabled`
  // is fixed at mount (--no-session never starts saving on clear either).
  const [sessionWriter, setSessionWriter] = useState(session);
  const sessionsEnabled = useRef(session !== null).current;
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
  // Bumped by /clear to remount <Static> after an ANSI screen wipe.
  const [staticKey, setStaticKey] = useState(0);

  const approvalResolver = useRef<((decision: ApprovalOutcome) => void) | null>(
    null,
  );

  const [pendingApproval, setPendingApproval] = useState<{ id: number; request: ApprovalRequest } | null>(
    null,
  );
  const buildHeader = (id: number, loaded: LoadedSession | null = null): UiItem => ({
    id,
    kind: "header",
    model: active.current.config.model,
    root,
    autoApprove: permissions.preset === "auto",
    resume: loaded === null ? undefined : `Resumed session ${loaded.header.id}` +
      (loaded.repaired > 0 ? ` · repaired ${loaded.repaired} invalid row(s)` : ""),
  });

  // Replayed history and the banner are committed once, before the live
  // region exists, so resumed rows scroll into history exactly like live ones.
  const [initial] = useState(() => {
    const header = buildHeader(0, resumed);

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
    return { items: [header, ...startup, ...view.items], nextId: view.nextId };
  });
  const [committed, setCommitted] = useState<UiItem[]>(initial.items);
  const nextId = useRef(initial.nextId);
  const [live, setLive] = useState<UiItem | null>(null);
  const [input, setInput] = useState("");
  // Slash-command popup: index into `matches` and a one-shot dismiss that
  // resets on the next keystroke (Esc keeps the typed text).
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [suggestionsDismissed, setSuggestionsDismissed] = useState(false);
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
    setModeSourceState("command");
    const notice = permissionModeNotice(next);
    history.current.push(notice);
    warnSession(sessionWriter?.appendPolicy(next) ?? null);
    warnSession(sessionWriter?.appendMessage(notice) ?? null);
    pushCommitted({
      id: nextId.current++,
      kind: "notice",
      tone: next === "auto" ? "error" : "info",
      text: `Mode: ${modeDescription(next)}`,
    });
  };

  const notice = (text: string, tone: "info" | "error" = "info") => {
    pushCommitted({ id: nextId.current++, kind: "notice", tone, text });
  };

  const prepareConfig = (config: Config) => {
    const current = active.current;
    const provider = config.protocol === current.config.protocol &&
      config.baseURL === current.config.baseURL &&
      config.apiKey === current.config.apiKey &&
      config.model === current.config.model &&
      config.maxOutputTokens === current.config.maxOutputTokens &&
      (config.protocol !== "openai-responses" ||
        (config.showReasoning === current.config.showReasoning &&
          config.sources.maxOutputTokens === current.config.sources.maxOutputTokens))
      ? current.provider
      : createProvider(config, { allowLegacyThinking: false });
    const commandTool = createRunCommandTool(config.shell);
    const tools = current.tools.map((tool) =>
      tool.name === commandTool.name ? commandTool : tool,
    );
    return { config, provider, tools };
  };

  const reportConfig = (config: Config, action: string) => {
    notice(`Configuration ${action} · ${config.model} (${config.protocol})`);
    for (const warning of config.settingsWarnings) notice(`Warning: ${warning}`);
  };

  const activateConfig = (next: ReturnType<typeof prepareConfig>) => {
    const previous = active.current.config.shell;
    const shell = next.config.shell;
    const executableKey = (file: string) => {
      const normalized = path.normalize(file);
      return process.platform === "win32" ? normalized.toLowerCase() : normalized;
    };
    if (previous.kind !== shell.kind || executableKey(previous.executable) !== executableKey(shell.executable)) {
      permissions.revokeSession("run_command");
    }
    active.current = next;
  };

  const reloadConfig = () => {
    try {
      const config = loadConfig({ showReasoning: showReasoningFlag });
      activateConfig(prepareConfig(config));
      reportConfig(config, "reloaded");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      notice(`Could not reload configuration. Still using the previous settings. ${detail}`, "error");
    }
  };

  const openConfig = (name: string) => {
    const field = configFieldIndex(name);
    if (field < 0) {
      notice("Unknown setting. Run /config to browse editable settings.", "error");
      return;
    }
    try {
      setConfigEdit({ document: readSettingsDocument(), field });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      notice(`Could not open configuration. ${detail}`, "error");
    }
  };

  const saveConfig = (values: Record<string, unknown>) => {
    if (configEdit === null) return;
    const { document } = configEdit;
    try {
      const settings = parseSettings(values, document.file);
      const config = resolveConfig(settings, { showReasoning: showReasoningFlag });
      const next = prepareConfig(config);
      writeSettingsDocument(document, values);
      activateConfig(next);
      setConfigEdit(null);
      reportConfig(config, "saved and applied");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      notice(`Could not save configuration. ${detail}`, "error");
    }
  };

  /**
   * /clear (aliases /new, /reset): a new conversation, not a truncated one.
   * The old session file is left intact for --sessions / --resume; only the
   * in-memory transcript and the terminal scrollback start over.
   */
  const clearConversation = () => {
    let writer: SessionWriter | null = null;
    if (sessionsEnabled) {
      try {
        writer = SessionWriter.create({ cwd: root, model: active.current.config.model });
      } catch (error) {
        notice(
          `Could not start a new session: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
        return;
      }
      warnSession(writer.appendPolicy(modeState));
      warnSession(writer.appendMessage(permissionModeNotice(modeState)));
    }
    setSessionWriter(writer);

    history.current = [
      {
        role: "system",
        content: buildSystemPrompt({
          root,
          permissions,
          instructions: instructions.text,
        }),
      },
      permissionModeNotice(modeState),
    ];

    // Ink cannot erase rows that already scrolled into history; wipe the
    // terminal ourselves and remount <Static> so the banner is the first row.
    if (process.stdout.isTTY) {
      process.stdout.write("\u001B[2J\u001B[H\u001B[3J");
    }
    sessionFailureShown.current = false;
    setCommitted([buildHeader(nextId.current++)]);
    setLive(null);
    setLiveReasoning(null);
    setReasoningHint(null);
    setStaticKey((key) => key + 1);
  };

  /**
   * /resume <id>: switch the conversation to a saved session (unique id
   * prefix accepted). Loads first so a bad id never disturbs the current
   * transcript; the old file stays as-is, and the process mode is kept
   * (option A) - only the write target changes.
   */
  const resumeConversation = (idArg: string) => {
    if (!sessionsEnabled) {
      notice(
        "Session resume requires sessions (not compatible with --no-session).",
        "error",
      );
      return;
    }
    const id = idArg.trim();
    if (id === "") {
      notice("Usage: /resume <id>. List sessions with /sessions.", "error");
      return;
    }

    let loaded: LoadedSession;
    try {
      loaded = resumeSession({ cwd: root, id });
    } catch (error) {
      notice(
        `Could not resume: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
      return;
    }

    if (sessionWriter !== null && sessionWriter.id === loaded.header.id) {
      notice(`Already in session ${loaded.header.id}.`);
      return;
    }

    let writer: SessionWriter;
    try {
      writer = SessionWriter.from(loaded);
    } catch (error) {
      notice(
        `Could not open session: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
      return;
    }
    setSessionWriter(writer);
    // Keep the process mode; record it on the target session so a later
    // --resume of this file starts from what the user actually ran here.
    warnSession(writer.appendPolicy(modeState));
    warnSession(writer.appendMessage(permissionModeNotice(modeState)));

    history.current = [
      {
        role: "system",
        content: buildSystemPrompt({
          root,
          permissions,
          instructions: instructions.text,
        }),
      },
      ...loaded.messages,
      permissionModeNotice(modeState),
    ];

    if (process.stdout.isTTY) {
      process.stdout.write("\u001B[2J\u001B[H\u001B[3J");
    }
    sessionFailureShown.current = false;

    const header = buildHeader(nextId.current++, loaded);
    const view = buildResumeView(loaded, nextId.current);
    setCommitted([header, ...view.items]);
    nextId.current = view.nextId;
    setLive(null);
    setLiveReasoning(null);
    setReasoningHint(null);
    setStaticKey((key) => key + 1);
  };

  const compactNow = async () => {
    const { config, provider, tools } = active.current;
    const contextConfig = resolveContextConfig(config.context);
    if (!contextConfig.enabled) {
      notice("Context compaction is off (context.compact is false).");
      return;
    }

    const specs = tools.map(toToolSpec);
    const estimate = estimateContextTokens(history.current, specs);
    const reserve = Math.min(
      contextConfig.reserveOutputTokens,
      Math.floor(contextConfig.window * 0.25),
    );
    const usable = Math.max(1, contextConfig.window - reserve);
    const summarizeLimit = usable * contextConfig.summarizeAt;
    if (estimate <= summarizeLimit) {
      notice(
        `Context is ${formatTokens(estimate)} tokens — under the summarize threshold (${formatTokens(summarizeLimit)}), nothing to compact.`,
      );
      return;
    }

    busyRef.current = true;
    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const actions = await prepareContext({
        messages: history.current,
        tools: specs,
        provider,
        model: config.model,
        config: contextConfig,
        signal: controller.signal,
        force: true,
      });
      if (actions.length === 0) {
        notice("Compaction made no changes.");
      } else {
        for (const action of actions) {
          notice(
            `⤓ context ${formatTokens(action.before)} → ${formatTokens(action.after)} tokens (${action.action})`,
          );
          warnSession(
            sessionWriter?.recordEvent(
              {
                type: "context-compacted",
                action: action.action,
                before: action.before,
                after: action.after,
              },
              history.current,
            ) ?? null,
          );
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        notice(
          `Compaction failed: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    } finally {
      abortRef.current = null;
      busyRef.current = false;
      setBusy(false);
    }
  };

  const handleCommand = async (command: ParsedCommand) => {
    if (command.kind === "unknown") {
      const shown = command.name.length > 0 ? ` /${command.name}` : " /";
      notice(`Unknown command${shown}. Type /help to list commands.`, "error");
      return;
    }
    if (command.kind !== "command") return;

    switch (command.name) {
      case "help":
        notice(commandHelp(modeState));
        return;
      case "clear":
        clearConversation();
        return;
      case "compact":
        await compactNow();
        return;
      case "resume":
        resumeConversation(command.args);
        return;
      case "sessions": {
        try {
          notice(formatSessions(listSessions(sessionsDir(root))));
        } catch (error) {
          notice(
            `Could not list sessions: ${error instanceof Error ? error.message : String(error)}`,
            "error",
          );
        }
        return;
      }
      case "mcp":
        notice(formatMcp(mcp));
        return;
      case "tools":
        notice(formatTools(active.current.tools));
        return;
      case "status": {
        const { config, tools } = active.current;
        const sessionInfo = sessionWriter !== null
          ? `Session ${sessionWriter.id} · resume with: cooper --resume ${sessionWriter.id}`
          : "Session: not saved (--no-session)";
        notice([
          `Workspace: ${root}`,
          `Instructions: ${describeInstructions(instructions.sources, root)}`,
          sessionInfo,
          formatStatus({
            config,
            mode: modeState,
            modeSource: modeSourceState,
            contextTokens: estimateContextTokens(history.current, tools.map(toToolSpec)),
          }),
        ].join("\n"));
        return;
      }
      case "reload":
        reloadConfig();
        return;
      case "config":
        openConfig(command.args);
        return;
      case "exit":
        exit();
        return;
      default:
        if (isModeCommand(command.name)) {
          switchMode(command.name);
        }
    }
  };

  // Record the mode that this process actually starts with. The notice is
  // appended after any resumed history; it never rewrites the system prompt.
  useEffect(() => {
    if (sessionWriter === null) return;
    warnSession(sessionWriter.appendPolicy(mode));
    warnSession(sessionWriter.appendMessage(permissionModeNotice(mode)));
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
    if (configEdit !== null || pendingApproval !== null || approvalResolver.current !== null) return;

    // Slash-command popup: ink-text-input ignores up/down/tab, so these
    // never fight the text cursor. Escape dismisses the popup first and
    // only aborts a turn when the popup is already closed.
    if (suggestionsVisible) {
      if (key.upArrow) {
        setSuggestionIndex((index) => Math.max(0, index - 1));
        return;
      }
      if (key.downArrow) {
        setSuggestionIndex((index) =>
          Math.min(matches.length - 1, index + 1),
        );
        return;
      }
      if (key.tab) {
        const spec = matches[activeIndex];
        if (spec !== undefined) setInput(completeCommand(input, spec));
        return;
      }
      if (key.escape) {
        setSuggestionsDismissed(true);
        return;
      }
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
    if (configEdit !== null) return;
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
      await handleCommand(parsed);
      return;
    }

    const text = parsed.text.trim();
    if (!text || busyRef.current) return;
    const { config, provider, tools } = active.current;
    const { showReasoning } = config;

    // Guards against a second submit landing before React re-renders and
    // unmounts the input (e.g. Enter key repeat).
    busyRef.current = true;

    const push = pushCommitted;

    setInput("");
    setBusy(true);
    push({ id: nextId.current++, kind: "user", text });
    history.current.push({ role: "user", content: text });
    warnSession(
      sessionWriter?.appendMessage({ role: "user", content: text }) ?? null,
    );

    const controller = new AbortController();
    abortRef.current = controller;

    let lineBuffer = "";
    let lineStarted = false;
    let liveLineId: number | null = null;
    let sawText = false;
    let formatLine = createMarkdownFormatter();

    // Reasoning is display-only: it never enters the conversation history.
    let reasoningBuffer = "";
    let reasoningChars = 0;
    let lastHintAt = 0;

    const commitLine = (text: string) => {
      const line = formatLine(text);
      if (line === null) return;
      push({
        id: nextId.current++,
        kind: "assistant-line",
        line,
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
        line: { kind: "text", spans: [{ text: preview }] },
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
      formatLine = createMarkdownFormatter();
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
            setPendingApproval({ id: nextId.current++, request });
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

          case "tool-approval": {
            const label = event.outcome === "deny" ? "Denied"
              : event.outcome === "allow-session" ? "Allowed until exit" : "Allowed once";
            const lines = event.summary.split(/\r?\n/);
            const action = event.call.name === "run_command" ? lines[1] ?? lines[0] : lines[0];
            notice(`${label} · ${truncate(visiblePreviewText(action ?? event.call.name), 120)}`);
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
            if (event.approval === "user-denied") break;
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
              processGrant: event.approval === "process-grant",
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
          warnSession(
            sessionWriter?.recordEvent(event, history.current) ?? null,
          );
        }
      }
    } catch (error) {
      resolveApproval("deny");
      setLive(null);
      if (controller.signal.aborted) {
        if (lineBuffer.length > 0) {
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

  const matches = filterCommands(input);
  const activeIndex = Math.min(suggestionIndex, Math.max(0, matches.length - 1));
  const suggestionsVisible = !busy && !suggestionsDismissed && matches.length > 0;
  const usageWidth = Math.max(...matches.map((spec) => spec.usage.length), 1);

  return (
    <Box flexDirection="column">
      <Static key={staticKey} items={committed} style={{ width: "100%" }}>
        {(item) => <ItemRow key={item.id} item={item} />}
      </Static>

      {liveReasoning !== null && !pendingApproval ? (
        <Box>
          <Text color="gray" dimColor wrap="truncate-end">
            {`· ${liveReasoning}`}
          </Text>
        </Box>
      ) : null}

      {live && !pendingApproval ? <ItemRow item={live} live /> : null}
      <Box marginTop={pendingApproval ? 0 : 1}>
        {pendingApproval ? (
          <ApprovalPanel
            key={pendingApproval.id}
            request={pendingApproval.request}
            onDecision={resolveApproval}
            onInterrupt={() => {
              abortRef.current?.abort();
              resolveApproval("deny");
            }}
          />
        ) : configEdit !== null ? (
          <ConfigEditor
            initial={configEdit.document.raw}
            initialIndex={configEdit.field}
            onSave={saveConfig}
            onCancel={() => setConfigEdit(null)}
          />
        ) : busy ? (
          <Text>
            <Text color="yellow">
              <Spinner type="dots" />
            </Text>
            <Text dimColor>
              {`  ${reasoningHint ?? "working"} · ${modeState} · esc to interrupt`}
            </Text>
          </Text>
        ) : (
          <Box flexDirection="column">
            {suggestionsVisible ? (
              <Box
                borderStyle="round"
                borderColor="cyan"
                paddingX={1}
                flexDirection="column"
              >
                {matches.map((spec, index) => (
                  <Text
                    key={spec.name}
                    inverse={index === activeIndex}
                    wrap="truncate-end"
                  >
                    {spec.usage.padEnd(usageWidth)}
                    {"  "}
                    {spec.description}
                  </Text>
                ))}
              </Box>
            ) : null}
            <Box>
              <Text color={modePromptColor(modeState)}>
                {`${modeState} > `}
              </Text>
              <TextInput
                value={input}
                onChange={(value) => {
                  setInput(value);
                  setSuggestionIndex(0);
                  setSuggestionsDismissed(false);
                }}
                onSubmit={(value) => {
                  // Enter runs the highlighted match when the popup is up, so
                  // `/re` + Enter behaves like `/resume` without typing it out.
                  if (suggestionsVisible) {
                    const spec = matches[activeIndex];
                    if (spec !== undefined) {
                      void submit(completeCommand(value, spec));
                      return;
                    }
                  }
                  void submit(value);
                }}
                placeholder="Ask Cooper to inspect or change the project…"
              />
            </Box>
          </Box>
        )}
      </Box>
    </Box>
  );
}
