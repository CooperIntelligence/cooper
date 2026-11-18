import { randomUUID } from "node:crypto";
import { loadSession, type AgentEvent, type LoadedSession, type Message, type RunPhase, type SessionWriter, type ToolCall } from "@cooper/core";

export function requireReadySession(session: LoadedSession): void {
  if (session.header.version !== 2) return;
  const submission = [...session.submissions.values()].at(-1);
  const latest = session.runs.findLast(({ turnId }) => turnId === submission?.turnId);
  if (session.damaged || session.needsReview || (submission && (latest?.end?.status !== "completed" || latest.reviewOnly))) {
    throw new Error("Open this conversation in Cooper Desktop to recover its last turn.");
  }
}

export function persistRunRecord(error: Error | null): void {
  if (error) throw error;
}

/** v2 CLI runs use the same journal and dispatch barrier as Desktop. */
export class CliSessionRun {
  private phase: RunPhase = "model";
  private stopped = false;

  constructor(private readonly writer: SessionWriter, messages: Message[]) {
    const turnId = randomUUID();
    for (const message of messages.slice(0, -1)) persistRunRecord(writer.appendMessage(message));
    persistRunRecord(writer.appendMessage(messages.at(-1)!, undefined, undefined,
      { kind: "submission", requestId: randomUUID(), turnId }));
    writer.startRun(turnId);
  }

  beforeTool = (call: ToolCall, mutable: boolean): void => {
    this.phase = "storage";
    this.writer.beforeTool(call, mutable);
    this.phase = "tool";
  };

  awaitingApproval(): void {
    this.phase = "approval";
  }

  record(event: AgentEvent, messages: Message[]): void {
    if (event.type === "turn-start") this.phase = "model";
    if (event.type === "max-turns") {
      persistRunRecord(this.writer.endRun("limit-reached", "limit-reached", this.phase));
    }
    const error = this.writer.recordEvent(event, messages);
    if (error) {
      this.phase = "storage";
      throw error;
    }
  }

  requestStop(): Error | null {
    this.stopped = true;
    return this.writer.stopRequested("user-stop");
  }

  finish(failed: boolean): Error | null {
    if (this.stopped) return this.writer.endRun("stopped", "user-stop", this.phase);
    if (!failed) return null;
    const reason = this.phase === "storage" ? "storage-error" : this.phase === "tool" ? "tool-error" : "provider-error";
    return this.writer.endRun("failed", reason, this.phase);
  }
}

export function reloadReadySession(writer: SessionWriter): LoadedSession {
  const current = loadSession(writer.file);
  requireReadySession(current);
  return current;
}
