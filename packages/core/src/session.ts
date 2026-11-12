import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AgentEvent } from "./agent.js";
import { cooperHome } from "./home.js";
import type { PermissionPreset } from "./permissions.js";
import { isContinuation } from "./provider/continuation.js";
import type { Message, RuntimeNoticeKind, ToolCall } from "./types.js";

export { cooperHome } from "./home.js";

/**
 * Conversation persistence.
 *
 * A session is an append-only JSONL file under the Cooper home directory:
 *
 *   <home>/projects/<workspace-key>/sessions/<id>.jsonl
 *
 * Every line is one record. A `checkpoint` record is written whenever context
 * compaction rewrites the transcript, so a resumed session starts from the
 * exact message list that was sent to the model instead of paying for the
 * same summary again. Corrupt or partial trailing lines are ignored on load,
 * and an incomplete tool-call group is dropped: the chat protocol requires
 * every tool call to have its results, so replaying a half-finished group
 * would make every later request fail.
 *
 * Reasoning display text is never stored here (see AGENTS.md rule 15).
 * Protocol continuation payloads (`reasoning_content`, signed thinking blocks,
 * encrypted items) are stored so a resumed session can replay them. "Always
 * allow this tool" is deliberately not stored either: permissions are per
 * process.
 */

const SESSION_VERSION = 1;
const SESSION_FILE_SUFFIX = ".jsonl";
const HEADER_PREFIX_BYTES = 64 * 1024;

export type SessionAction = "prune" | "summarize" | "truncate";

export type SessionHeader = {
  type: "session";
  version: number;
  id: string;
  /** Absolute workspace root this session belongs to. */
  cwd: string;
  model: string;
  createdAt: string;
};

/** Display metadata for a tool result, so resumed rows look like live ones. */
export type SessionToolUi = {
  toolName: string;
  summary: string;
  isError: boolean;
  denied: boolean;
  durationMs: number;
};

export type SessionMessageRecord = {
  type: "message";
  at: string;
  message: Message;
  ui?: SessionToolUi;
};

export type SessionCheckpointRecord = {
  type: "checkpoint";
  at: string;
  action: SessionAction;
  /** Post-compaction transcript, without the regenerated system message. */
  messages: Message[];
  /** Parallel to `messages`; null for non-tool messages. */
  ui?: (SessionToolUi | null)[];
};

/**
 * The permission mode in effect for this process. Kept separate from message
 * records so a resume can restore the mode without scanning runtime notices.
 * Session grants are never persisted.
 */
export type SessionPolicyRecord = {
  type: "policy";
  at: string;
  preset: PermissionPreset;
};

export type SessionRecord =
  | SessionHeader
  | SessionMessageRecord
  | SessionCheckpointRecord
  | SessionPolicyRecord;

export type SessionSummary = {
  id: string;
  file: string;
  cwd: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  /** First user message, flattened and truncated for a listing. */
  preview: string;
};

export type LoadedSession = {
  header: SessionHeader;
  file: string;
  messages: Message[];
  /** UI metadata keyed by the index in `messages`. */
  toolUi: Map<number, SessionToolUi>;
  /** Last permission mode recorded in the session, if any. */
  preset: PermissionPreset | null;
  /** Number of malformed rows and dropped messages repaired during load. */
  repaired: number;
};

export type CreateSessionOptions = {
  cwd: string;
  model: string;
  /** Overrides the `cooperHome()` anchor; used by tests. */
  home?: string;
  now?: Date;
  /** Explicit id (tests or import). Generated from the timestamp otherwise. */
  id?: string;
};

export type ResumeSessionOptions = {
  cwd: string;
  id: string;
  home?: string;
};

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * A stable, inspectable directory name per workspace. Windows paths are
 * lower-cased before hashing so `D:\App` and `d:\app` share sessions.
 */
export function workspaceKey(cwd: string): string {
  const resolved = path.resolve(cwd);
  const normalized =
    process.platform === "win32" ? resolved.toLowerCase() : resolved;
  const sanitized =
    normalized
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "workspace";
  const hash = crypto
    .createHash("sha1")
    .update(normalized)
    .digest("hex")
    .slice(0, 8);
  return `${sanitized}-${hash}`;
}

export function sessionsDir(cwd: string, home = cooperHome()): string {
  return path.join(home, "projects", workspaceKey(cwd), "sessions");
}

export function sameWorkspace(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32"
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

/** Machine-readable id that also sorts naturally by creation time. */
export function newSessionId(now: Date = new Date()): string {
  const stamp = [
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`,
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`,
  ].join("-");
  return `${stamp}-${crypto.randomBytes(3).toString("hex")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function parseToolCalls(value: unknown): ToolCall[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const calls: ToolCall[] = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      !isString(entry.id) ||
      !isString(entry.name) ||
      !isString(entry.arguments)
    ) {
      return null;
    }
    calls.push({
      id: entry.id,
      name: entry.name,
      arguments: entry.arguments,
    });
  }
  return calls;
}

function isPermissionPreset(value: unknown): value is PermissionPreset {
  return value === "plan" || value === "ask" || value === "auto";
}

function isRuntimeNoticeKind(value: unknown): value is RuntimeNoticeKind {
  return value === "permission-mode";
}

function parseMessage(value: unknown): Message | null {
  if (!isRecord(value) || !isString(value.role)) return null;

  switch (value.role) {
    case "system":
      return isString(value.content)
        ? { role: "system", content: value.content }
        : null;

    case "user": {
      if (!isString(value.content)) return null;
      const runtime = isRuntimeNoticeKind(value.runtime)
        ? value.runtime
        : undefined;
      return {
        role: "user",
        content: value.content,
        ...(runtime !== undefined ? { runtime } : {}),
      };
    }

    case "assistant": {
      if (!isString(value.content)) return null;
      const toolCalls = parseToolCalls(value.toolCalls);
      if (toolCalls === null) return null;
      // Protocol continuation data must survive a resume: a tool loop that
      // cannot replay its reasoning is rejected by DeepSeek/Kimi/Anthropic.
      const continuation = isContinuation(value.continuation)
        ? value.continuation
        : undefined;
      // Legacy sessions stored Anthropic thinking blocks under `providerData`.
      const providerData = isRecord(value.providerData)
        ? value.providerData
        : undefined;
      return {
        role: "assistant",
        content: value.content,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
        ...(continuation !== undefined ? { continuation } : {}),
        ...(providerData !== undefined ? { providerData } : {}),
      };
    }

    case "tool":
      return isString(value.toolCallId) && isString(value.content)
        ? {
            role: "tool",
            toolCallId: value.toolCallId,
            content: value.content,
            ...(typeof value.isError === "boolean" ? { isError: value.isError } : {}),
          }
        : null;

    default:
      return null;
  }
}

function parseMessageArray(value: unknown): Message[] | null {
  if (!Array.isArray(value)) return null;
  const messages: Message[] = [];
  for (const entry of value) {
    const message = parseMessage(entry);
    if (message === null) return null;
    // The system prompt is regenerated by the host on resume, so a stored one
    // is stale by construction.
    if (message.role !== "system") messages.push(message);
  }
  return messages;
}

function parseToolUi(value: unknown): SessionToolUi | undefined {
  if (!isRecord(value)) return undefined;
  if (!isString(value.toolName) || !isString(value.summary)) return undefined;
  return {
    toolName: value.toolName,
    summary: value.summary,
    isError: value.isError === true,
    denied: value.denied === true,
    durationMs:
      typeof value.durationMs === "number" ? value.durationMs : 0,
  };
}

function parseHeader(value: Record<string, unknown>, file: string): SessionHeader {
  if (value.type !== "session") {
    throw new Error(`Not a Cooper session file: ${file}`);
  }
  if (value.version !== SESSION_VERSION) {
    throw new Error(
      `Unsupported session version ${String(value.version)} in ${file}.`,
    );
  }
  if (
    !isString(value.id) ||
    !isString(value.cwd) ||
    !isString(value.model) ||
    !isString(value.createdAt)
  ) {
    throw new Error(`Malformed session header in ${file}.`);
  }
  return {
    type: "session",
    version: SESSION_VERSION,
    id: value.id,
    cwd: value.cwd,
    model: value.model,
    createdAt: value.createdAt,
  };
}

type TranscriptEntry = {
  message: Message;
  ui?: SessionToolUi;
};

/**
 * Drops orphaned tool results and any tool-call group whose results are
 * incomplete. Called on load because a process can die between recording the
 * assistant message and its tool results.
 */
function repairEntries(entries: TranscriptEntry[]): {
  entries: TranscriptEntry[];
  dropped: number;
} {
  const out: TranscriptEntry[] = [];
  let dropped = 0;
  let index = 0;

  while (index < entries.length) {
    const entry = entries[index];
    if (entry === undefined) break;
    const { message } = entry;

    if (message.role === "assistant" && (message.toolCalls?.length ?? 0) > 0) {
      const expected = new Set(message.toolCalls?.map((call) => call.id) ?? []);
      const results: TranscriptEntry[] = [];
      let next = index + 1;

      while (next < entries.length) {
        const candidate = entries[next];
        if (candidate === undefined) break;
        if (candidate.message.role !== "tool") break;
        if (!expected.has(candidate.message.toolCallId)) break;
        expected.delete(candidate.message.toolCallId);
        results.push(candidate);
        next += 1;
      }

      if (expected.size > 0) {
        // Incomplete group: drop the assistant call and the partial results.
        dropped += 1 + results.length;
        index = next;
        continue;
      }

      out.push(entry, ...results);
      index = next;
      continue;
    }

    if (message.role === "tool") {
      dropped += 1;
      index += 1;
      continue;
    }

    out.push(entry);
    index += 1;
  }

  return { entries: out, dropped };
}

/**
 * Reads and repairs a session file. Unknown record types and malformed JSON
 * lines are skipped (a crash can leave a partial last line), but a missing or
 * unsupported header is a hard error so we never silently resume garbage.
 */
export function loadSession(file: string): LoadedSession {
  const text = fs.readFileSync(file, "utf8");
  let header: SessionHeader | null = null;
  let preset: PermissionPreset | null = null;
  let skipped = 0;
  let entries: TranscriptEntry[] = [];

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;

    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      skipped += 1;
      continue;
    }
    if (!isRecord(value) || !isString(value.type)) {
      skipped += 1;
      continue;
    }

    if (header === null) {
      if (value.type !== "session") {
        skipped += 1;
        continue;
      }
      header = parseHeader(value, file);
      continue;
    }

    switch (value.type) {
      case "message": {
        const message = parseMessage(value.message);
        if (message === null || message.role === "system") {
          skipped += 1;
          continue;
        }
        entries.push({ message, ui: parseToolUi(value.ui) });
        break;
      }

      case "checkpoint": {
        const messages = parseMessageArray(value.messages);
        if (messages === null) {
          skipped += 1;
          continue;
        }
        const ui = Array.isArray(value.ui)
          ? value.ui.map((entry) => parseToolUi(entry))
          : [];
        entries = messages.map((message, index) => ({
          message,
          ui: ui[index] ?? undefined,
        }));
        break;
      }

      case "policy":
        if (isPermissionPreset(value.preset)) preset = value.preset;
        else skipped += 1;
        break;

      case "session":
        // A repeated header (e.g. from a future append) carries no new state.
        break;

      default:
        skipped += 1;
        break;
    }
  }

  if (header === null) {
    throw new Error(`Not a Cooper session file: ${file}`);
  }

  const repaired = repairEntries(entries);
  const messages: Message[] = [];
  const toolUi = new Map<number, SessionToolUi>();

  for (const entry of repaired.entries) {
    const index = messages.length;
    messages.push(entry.message);
    if (entry.message.role === "tool" && entry.ui !== undefined) {
      toolUi.set(index, entry.ui);
    }
  }

  return {
    header,
    file,
    messages,
    toolUi,
    preset,
    repaired: skipped + repaired.dropped,
  };
}

/**
 * Appends records to a session. Write failures are returned instead of thrown
 * so a full disk cannot take down an otherwise working conversation.
 */
export class SessionWriter {
  readonly header: SessionHeader;
  readonly file: string;
  private readonly toolUiByCall = new Map<string, SessionToolUi>();

  private constructor(header: SessionHeader, file: string) {
    this.header = header;
    this.file = file;
  }

  get id(): string {
    return this.header.id;
  }

  static create(options: CreateSessionOptions): SessionWriter {
    const cwd = path.resolve(options.cwd);
    const now = options.now ?? new Date();
    const id = options.id ?? newSessionId(now);
    if (!SESSION_ID_PATTERN.test(id)) {
      throw new Error(`Invalid session id "${id}".`);
    }

    const dir = sessionsDir(cwd, options.home);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${id}${SESSION_FILE_SUFFIX}`);
    const header: SessionHeader = {
      type: "session",
      version: SESSION_VERSION,
      id,
      cwd,
      model: options.model,
      createdAt: now.toISOString(),
    };

    fs.writeFileSync(file, `${JSON.stringify(header)}\n`, {
      encoding: "utf8",
      flag: "wx",
      // Conversations can contain source code and command output.
      mode: 0o600,
    });
    return new SessionWriter(header, file);
  }

  /** Continues an existing session, seeding tool labels for checkpoints. */
  static from(session: LoadedSession): SessionWriter {
    const writer = new SessionWriter(session.header, session.file);
    for (const [index, ui] of session.toolUi) {
      const message = session.messages[index];
      if (message?.role === "tool") {
        writer.toolUiByCall.set(message.toolCallId, ui);
      }
    }
    return writer;
  }

  private append(record: SessionRecord): Error | null {
    try {
      fs.appendFileSync(this.file, `${JSON.stringify(record)}\n`, "utf8");
      return null;
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  }

  /** Records the effective permission mode for this process. */
  appendPolicy(
    preset: PermissionPreset,
    now: Date = new Date(),
  ): Error | null {
    return this.append({
      type: "policy",
      at: now.toISOString(),
      preset,
    });
  }

  appendMessage(
    message: Message,
    ui?: SessionToolUi,
    now: Date = new Date(),
  ): Error | null {
    // The system prompt is rebuilt per run (mode and instructions can change).
    if (message.role === "system") return null;

    const record: SessionMessageRecord = {
      type: "message",
      at: now.toISOString(),
      message,
    };
    if (message.role === "tool" && ui !== undefined) {
      record.ui = ui;
      this.toolUiByCall.set(message.toolCallId, ui);
    }
    return this.append(record);
  }

  /**
   * Snapshots the effective transcript after compaction. Earlier message
   * records stay in the file as an audit trail; loading starts from the last
   * checkpoint and replays only what follows it.
   */
  appendCheckpoint(
    action: SessionAction,
    messages: Message[],
    now: Date = new Date(),
  ): Error | null {
    const body = messages.filter((message) => message.role !== "system");
    const ui = body.map((message) =>
      message.role === "tool"
        ? (this.toolUiByCall.get(message.toolCallId) ?? null)
        : null,
    );
    return this.append({
      type: "checkpoint",
      at: now.toISOString(),
      action,
      messages: body,
      ui,
    });
  }

  /**
   * Records the durable parts of an agent event. Text and reasoning deltas are
   * ephemeral; the assistant message arrives whole in `assistant-done`.
   */
  recordEvent(
    event: AgentEvent,
    messages: Message[],
    now: Date = new Date(),
  ): Error | null {
    switch (event.type) {
      case "assistant-done": {
        const message: Message =
          event.toolCalls.length > 0
            ? {
                role: "assistant",
                content: event.content,
                toolCalls: event.toolCalls,
                ...(event.continuation !== undefined
                  ? { continuation: event.continuation }
                  : event.providerData !== undefined
                    ? { providerData: event.providerData }
                    : {}),
              }
            : {
                role: "assistant",
                content: event.content,
                ...(event.continuation !== undefined
                  ? { continuation: event.continuation }
                  : event.providerData !== undefined
                    ? { providerData: event.providerData }
                    : {}),
              };
        return this.appendMessage(message, undefined, now);
      }

      case "tool-end":
        return this.appendMessage(
          {
            role: "tool",
            toolCallId: event.call.id,
            content: event.result.content,
            ...(event.isError ? { isError: true } : {}),
          },
          {
            toolName: event.call.name,
            summary: event.summary,
            isError: event.isError,
            denied: event.denied,
            durationMs: event.durationMs,
          },
          now,
        );

      case "context-compacted":
        return this.appendCheckpoint(event.action, messages, now);

      default:
        return null;
    }
  }
}

export function createSession(options: CreateSessionOptions): SessionWriter {
  return SessionWriter.create(options);
}

/**
 * Resolves an exact id or a unique prefix to a session file path.
 */
export function findSessionFile(dir: string, id: string): string {
  const trimmed = id.trim();
  if (!SESSION_ID_PATTERN.test(trimmed)) {
    throw new Error(`Invalid session id "${id}".`);
  }

  const exact = path.join(dir, `${trimmed}${SESSION_FILE_SUFFIX}`);
  if (fs.existsSync(exact)) return exact;

  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `No session matching "${id}". Run with --sessions to list sessions.`,
      );
    }
    throw error;
  }

  const matches = names.filter(
    (name) =>
      name.endsWith(SESSION_FILE_SUFFIX) &&
      name.slice(0, -SESSION_FILE_SUFFIX.length).startsWith(trimmed),
  );

  if (matches.length === 1) {
    const match = matches[0];
    if (match !== undefined) return path.join(dir, match);
  }
  if (matches.length > 1) {
    throw new Error(
      `Session id "${id}" is ambiguous: ${matches.join(", ")}. Use more characters.`,
    );
  }
  throw new Error(
    `No session matching "${id}". Run with --sessions to list sessions.`,
  );
}

export function resumeSession(options: ResumeSessionOptions): LoadedSession {
  const cwd = path.resolve(options.cwd);
  const dir = sessionsDir(cwd, options.home);
  const session = loadSession(findSessionFile(dir, options.id));
  if (!sameWorkspace(session.header.cwd, cwd)) {
    throw new Error(
      `Session ${session.header.id} belongs to ${session.header.cwd}, not ${cwd}.`,
    );
  }
  return session;
}

function readPrefix(file: string, maxBytes: number): string {
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const bytes = fs.readSync(fd, buffer, 0, maxBytes, 0);
    const raw = buffer.subarray(0, bytes).toString("utf8");
    if (bytes < maxBytes) return raw;
    // Drop the truncated trailing line to avoid parsing half a record.
    const cut = raw.lastIndexOf("\n");
    return cut === -1 ? "" : raw.slice(0, cut);
  } finally {
    fs.closeSync(fd);
  }
}

function previewOf(text: string): string {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      !isRecord(value) ||
      value.type !== "message" ||
      !isRecord(value.message) ||
      value.message.role !== "user" ||
      !isString(value.message.content) ||
      isRuntimeNoticeKind(value.message.runtime)
    ) {
      continue;
    }
    const flat = value.message.content.replace(/\s+/g, " ").trim();
    if (flat.length > 0) {
      return flat.length > 100 ? `${flat.slice(0, 99)}…` : flat;
    }
  }
  return "(no messages)";
}

/** Session summaries for `--sessions`, newest first. */
export function listSessions(dir: string): SessionSummary[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const summaries: SessionSummary[] = [];
  for (const name of names) {
    if (!name.endsWith(SESSION_FILE_SUFFIX)) continue;
    const file = path.join(dir, name);
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile()) continue;
      const prefix = readPrefix(file, HEADER_PREFIX_BYTES);
      const firstLine = prefix.split(/\r?\n/, 1)[0] ?? "";
      const headerValue: unknown = JSON.parse(firstLine);
      if (!isRecord(headerValue)) continue;
      const header = parseHeader(headerValue, file);
      summaries.push({
        id: header.id,
        file,
        cwd: header.cwd,
        model: header.model,
        createdAt: header.createdAt,
        updatedAt: stat.mtime.toISOString(),
        preview: previewOf(prefix),
      });
    } catch {
      // A file that is not a valid session should not break the listing.
      continue;
    }
  }

  summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return summaries;
}
