import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  PermissionPolicy, SessionWriter, createRunCommandTool, createSkillTool, createWebSearchTool, diffText, discoverSkills,
  hasSessionLocks, isRuntimeNotice, latestRuntimeNotice, listSessions, loadProjectInstructions, loadSession, newSessionId, permissionModeNotice,
  resumeSession, runAgent, sessionWriterBusy, sessionsDir, workspaceKey,
  type ApprovalOutcome, type ApprovalRequest, type LoadedSession, type Message,
  type PermissionPreset, type Provider, type RunPhase, type SkillCatalog, type StopCause, type Tool, type ToolCall,
} from "@cooper/core";
import {
  buildSystemPrompt, createProvider, loadConfig, modelBudget, needsResumeBudgetCheck,
  prepareTools, selectModelTier, transitionMessage, type Config, type PreparedTools,
  writeSettingsDocument, type SettingsDocument,
} from "@cooper/host";
import type { Draft, DraftStore } from "./drafts.js";
import type { ActiveTool, ApprovalEvent, DesktopDraft, DesktopEvent, DesktopMode, DesktopState, RunDisplay, ToolDisplay } from "./ipc.js";

type Workspace = {
  root: string;
  config: Config;
  instructions: string;
  skills: SkillCatalog;
  tools: Tool[];
  prepared: PreparedTools;
};

type Chat = {
  config: Config;
  provider: Provider;
  permissions: PermissionPolicy;
  messages: Message[];
  writer: SessionWriter | null;
  sessionId: string | null;
  saved?: LoadedSession;
  notice: Message;
  recordMode: boolean;
  preserveFittingHistory: boolean;
};

function persist(error: Error | null): void {
  if (error) throw error;
}

function projectRun(session: LoadedSession | undefined): RunDisplay | undefined {
  if (!session) return undefined;
  const submission = [...session.submissions.values()].at(-1);
  if (!submission) return undefined;
  const run = session.runs.findLast(({ turnId }) => turnId === submission.turnId);
  const status = run?.end?.status ?? (run ? "interrupted" : "pending");
  const reviewed = Boolean(run?.reviewOnly && run.end?.status === "completed");
  return { sessionId: session.header.id, requestId: submission.requestId, turnId: submission.turnId, runId: run?.runId, status,
    reason: run?.end?.reason ?? (run ? "unknown" : undefined), stopRequested: run?.stopRequested,
    continuable: status !== "completed" || reviewed,
    needsReview: Boolean(run?.reviewOnly) || (status !== "completed" && session.needsReview), reviewed };
}

function describeApproval({ preview, summary }: ApprovalRequest): { title: string; preview: string } {
  if (preview?.kind === "diff") {
    const diff = diffText(preview.before, preview.after, { preserveLineEndings: true });
    const lines = diff.hunks.flatMap((hunk) => [
      `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`,
      ...hunk.lines.map((line) =>
        (line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " ") +
        line.text.replace(/\r\n$/, "␍").replace(/\n$/, ""),
      ),
    ]);
    return { title: preview.path, preview: lines.join("\n") || (preview.createsFile ? "Create an empty file." : "No changes.") };
  }
  if (preview?.kind === "command") {
    return {
      title: "Run command",
      preview: `Purpose: ${preview.description}\n\n${preview.shell} · ${preview.cwd}\n\n${preview.command}`,
    };
  }
  if (preview?.kind === "text") return { title: preview.title, preview: preview.text };
  return {
    title: "Approve tool",
    preview: preview?.kind === "unavailable" ? `${summary}\n\n${preview.reason}` : summary,
  };
}

export class DesktopRuntime {
  private workspace?: Workspace;
  private chat?: Chat;
  private opening?: Promise<DesktopState>;
  private running?: Promise<DesktopState>;
  private controller?: AbortController;
  private active?: { writer: SessionWriter; run: RunDisplay; phase: RunPhase };
  private approval?: { event: ApprovalEvent; resolve(outcome: ApprovalOutcome): void };
  private preparingTool = false;
  private activeTool?: ActiveTool;

  constructor(
    private readonly emit: (event: DesktopEvent) => void,
    private readonly drafts: DraftStore,
    private readonly home?: string,
    private readonly useV2 = hasSessionLocks(),
  ) {}

  getState(): DesktopState | null {
    if (!this.workspace || !this.chat) return null;
    const { workspace, chat } = this.current();
    const active = this.active;
    const writer = active?.writer ?? (this.running && chat.sessionId ? chat.writer : null);
    const state = this.snapshot(workspace, chat, writer ? loadSession(writer.file) : chat.saved);
    return { ...state, run: active?.writer.hasActiveRun ? active.run : state.run,
      approval: this.approval?.event, preparingTool: this.preparingTool, activeTool: this.activeTool,
      running: Boolean(this.running) };
  }

  saveConnection(config: Config, document: SettingsDocument, values: Record<string, unknown>): DesktopState | null {
    this.requireIdle();
    const workspace = this.workspace;
    const chat = this.chat;
    const selected = selectModelTier(config, chat?.config.modelSelection?.tier);
    const provider = createProvider(selected);
    if (!workspace || !chat) {
      writeSettingsDocument(document, values);
      return null;
    }

    let tools = workspace.tools;
    if (config.shell.kind !== workspace.config.shell.kind || config.shell.executable !== workspace.config.shell.executable) {
      const command = createRunCommandTool(config.shell);
      tools = tools.map((tool) => tool.name === command.name ? command : tool);
    }
    if (config.webSearchApiKey !== workspace.config.webSearchApiKey) {
      tools = tools.filter((tool) => tool.name !== "web_search");
      if (config.webSearchApiKey) tools.push(createWebSearchTool(config.webSearchApiKey));
    }
    const previous = chat.config;
    const budgetChanged = (selected.modelSelection?.inputLimit ?? 0) < (previous.modelSelection?.inputLimit ?? 0);
    const checkBudget = budgetChanged || (Boolean(selected.modelSelection?.tier) &&
      (selected.model !== previous.model || selected.protocol !== previous.protocol || selected.baseURL !== previous.baseURL));
    if (checkBudget) {
      const budget = modelBudget(selected, chat.messages, tools, provider);
      if (budget.estimated > budget.limit) {
        throw new Error(`${transitionMessage(selected, budget)} Open a new conversation and try again.`);
      }
    }

    writeSettingsDocument(document, values);
    workspace.config = config;
    workspace.tools = tools;
    chat.config = selected;
    chat.provider = provider;
    chat.recordMode = true;
    chat.preserveFittingHistory ||= checkBudget;
    return this.snapshot(workspace, chat);
  }

  async openWorkspace(directory: string): Promise<DesktopState> {
    this.requireIdle();
    if (this.workspace && this.chat) this.drafts.flush(this.draftKey(this.workspace, this.chat));
    const opening = this.prepareWorkspace(directory);
    this.opening = opening;
    try {
      return await opening;
    } finally {
      this.opening = undefined;
    }
  }

  private async prepareWorkspace(directory: string): Promise<DesktopState> {
    const root = resolve(directory);
    if (!(await stat(root)).isDirectory()) throw new Error(`Not a directory: ${root}`);
    const config = loadConfig({ home: this.home });
    const userHome = this.home === undefined ? undefined : dirname(this.home);
    const [instructions, skills] = await Promise.all([
      loadProjectInstructions(root, { home: userHome }),
      discoverSkills(root, userHome),
    ]);
    const prepared = await prepareTools({
      root, home: this.home, explicit: [], loadProject: false,
      shell: config.shell, webSearchApiKey: config.webSearchApiKey,
    });
    const tools = skills.skills.size ? [...prepared.tools, createSkillTool(skills)] : prepared.tools;
    const workspace = { root, config, instructions: instructions.text, skills, prepared, tools };
    try {
      let chat = this.createChat(workspace);
      const key = this.draftKey(workspace, chat);
      let warning: string | undefined;
      try {
        const original = this.findAcceptedDraft(workspace, this.drafts.read(key));
        if (original) {
          chat = this.createChat(workspace, original);
          warning = this.clearAcceptedDraft(key);
        }
      } catch { /* The regular draft view reports an unreadable draft or receipt. */ }
      const state = this.snapshot(workspace, chat);
      if (warning) state.draft.warning = warning;
      await this.workspace?.prepared.close();
      this.workspace = workspace;
      this.chat = chat;
      return state;
    } catch (error) {
      await prepared.close();
      throw error;
    }
  }

  private createChat(workspace: Workspace, saved?: LoadedSession): Chat {
    const config = selectModelTier(workspace.config, saved?.modelSelection?.tier);
    const mode = saved?.preset === "plan" || saved?.preset === "ask" ? saved.preset : config.defaultMode ?? "ask";
    const permissions = new PermissionPolicy({ interactive: true, preset: mode });
    const system = buildSystemPrompt({
      root: workspace.root, desktop: true, permissions, instructions: workspace.instructions, skills: workspace.skills,
    });
    const notice = permissionModeNotice(mode);
    const messages: Message[] = [{ role: "system", content: system }, ...(saved?.messages ?? [])];
    if (saved?.header.version !== 2 || latestRuntimeNotice(messages)?.content !== notice.content) messages.push(notice);
    const provider = createProvider(config);
    const preserveFittingHistory = needsResumeBudgetCheck(config, saved?.modelSelection);
    if (saved && preserveFittingHistory) {
      const budget = modelBudget(config, messages, workspace.tools, provider);
      if (budget.estimated > budget.limit) throw new Error(transitionMessage(config, budget));
    }
    return {
      messages, config, provider, permissions, notice, recordMode: true, preserveFittingHistory,
      writer: saved?.header.version === 1 ? SessionWriter.from(saved) : null,
      sessionId: saved?.header.id ?? null,
      saved,
    };
  }

  newChat(id?: string): DesktopState {
    this.requireIdle();
    const { workspace, chat: previous } = this.current();
    this.drafts.flush(this.draftKey(workspace, previous));
    const saved = id === undefined ? undefined : resumeSession({ cwd: workspace.root, home: this.home, id });
    const chat = this.createChat(workspace, saved);
    const state = this.snapshot(workspace, chat);
    this.chat = chat;
    return state;
  }

  saveDraft(key: string, text: string): void {
    const { workspace, chat } = this.current();
    if (key === this.draftKey(workspace, chat) && !this.running && !this.opening && !this.readDraft(workspace, chat).pending) {
      this.drafts.edit(key, text);
    }
  }

  keepEditingDraft(key: string): DesktopState {
    this.requireIdle();
    const { workspace, chat } = this.current();
    if (key !== this.draftKey(workspace, chat)) throw new Error("This draft is no longer open.");
    const draft = this.drafts.read(key);
    if (draft.pending && chat.writer) {
      const history = resumeSession({ cwd: workspace.root, home: this.home, id: chat.writer.id });
      chat.writer = SessionWriter.from(history);
      this.refresh(chat, history);
    }
    this.drafts.write(key, { ...draft, pending: false });
    return this.snapshot(workspace, chat);
  }

  setMode(mode: DesktopMode): DesktopState {
    this.requireIdle();
    const { workspace, chat } = this.current();
    if (mode !== chat.permissions.preset) {
      const notice = permissionModeNotice(mode);
      if (chat.writer || chat.saved) {
        const writer = chat.writer ?? SessionWriter.from(chat.saved!, { writeV2: true });
        try {
          if (writer.header.version === 2) this.refresh(chat, loadSession(writer.file));
          this.persistMode(chat, writer, notice, mode);
        } finally {
          if (writer.header.version === 2) writer.close();
        }
      }
      chat.permissions.setPreset(mode);
      chat.messages.push(notice);
      chat.notice = notice;
    }
    return this.snapshot(workspace, chat);
  }

  async send(prompt: string): Promise<DesktopState> {
    this.requireIdle();
    const { workspace, chat } = this.current();
    const text = prompt.trim();
    if (!text) throw new Error("Enter a message first.");
    return this.start((signal) => this.submitAndRun(workspace, chat, prompt, text, signal));
  }

  async continueTurn(turnId: string, confirmReview = false): Promise<DesktopState> {
    this.requireIdle();
    const { workspace, chat } = this.current();
    if (chat.saved?.header.version !== 2) throw new Error("This conversation does not support continuation.");
    return this.start(async (signal) => {
      const writer = SessionWriter.from(chat.saved!, { writeV2: true });
      try {
        const session = loadSession(writer.file);
        const run = projectRun(session);
        if (!run?.continuable || run.turnId !== turnId) throw new Error("This turn is no longer available to continue.");
        if (run.reviewed && !confirmReview) throw new Error("Confirm the recovery check before continuing.");
        persist(writer.recover(session));
        this.refresh(chat, loadSession(writer.file));
        if (chat.recordMode) this.persistMode(chat, writer, chat.notice, chat.permissions.preset);
        const reviewOnly = run.needsReview && !run.reviewed;
        const message: Message = { role: "user", runtime: "recovery", content: reviewOnly
          ? "The user asked to review an interrupted run. Check current state with read-only tools and report any uncertain effects."
          : "The user asked to continue this turn. Use the confirmed tool results and current workspace state." };
        persist(writer.appendMessage(message));
        chat.messages.push(message);
        return await this.run(workspace, chat, writer, signal, { turnId, requestId: run.requestId, reviewOnly, reviewConfirmed: run.reviewed });
      } finally {
        writer.close();
      }
    });
  }

  private async start(operation: (signal: AbortSignal) => Promise<DesktopState>): Promise<DesktopState> {
    const controller = new AbortController();
    this.controller = controller;
    const running = operation(controller.signal);
    this.running = running;
    try {
      return await running;
    } finally {
      this.running = undefined;
      this.controller = undefined;
      this.active = undefined;
      this.emit({ type: "run-settled" });
    }
  }

  private async submitAndRun(workspace: Workspace, chat: Chat, draftText: string, text: string, signal: AbortSignal): Promise<DesktopState> {
    const key = this.draftKey(workspace, chat);
    const previous = this.drafts.read(key);
    if (previous.pending) throw new Error("Check the pending draft before sending again.");
    const version = chat.saved?.header.version ?? chat.writer?.header.version ?? (this.useV2 ? 2 : 1);
    const submission = version === 2
      ? (previous.text === draftText && previous.submission) || { sessionId: chat.sessionId ?? newSessionId(), requestId: randomUUID() }
      : undefined;
    const draft: Draft = { text: draftText, pending: true, ...(submission ? { submission } : {}) };
    this.drafts.write(key, draft);

    let writer: SessionWriter | undefined;
    let mayHaveWritten = false;
    try {
      const linked = submission && this.readSubmissionSession(workspace, submission.sessionId);
      writer = chat.writer ?? (linked
        ? SessionWriter.from(linked, { writeV2: true })
        : SessionWriter.create({ cwd: workspace.root, model: chat.config.model, home: this.home,
          id: submission?.sessionId, version: submission ? 2 : 1 }));
      if (!submission) chat.writer = writer;
      if (submission) {
        const current = loadSession(writer.file);
        const receipt = current.submissions.get(submission.requestId);
        if (receipt) {
          if (receipt.text !== text) throw new Error("This submission ID belongs to a different message.");
          chat.sessionId = writer.id;
          this.refresh(chat, current);
          this.clearAcceptedDraft(key);
          const state = this.snapshot(workspace, chat);
          this.emit({ type: "reconciled", state });
          return state;
        }
        if (current.damaged && previous.submission?.requestId === submission.requestId) {
          mayHaveWritten = true;
          throw new Error("The original submission cannot be verified in the damaged session log.");
        }
        if (projectRun(current)?.needsReview) throw new Error("Continue and review the interrupted turn before sending a new message.");
        persist(writer.recover(current));
        this.refresh(chat, loadSession(writer.file));
      }
      if (chat.recordMode) this.persistMode(chat, writer, chat.notice, chat.permissions.preset);
      const turnId = submission ? randomUUID() : undefined;
      const user: Message = { role: "user", content: text };
      mayHaveWritten = true;
      persist(writer.appendMessage(user, undefined, undefined, submission && turnId
        ? { kind: "submission", requestId: submission.requestId, turnId } : undefined));
      chat.messages.push(user);
      chat.sessionId = writer.id;
      const warning = this.clearAcceptedDraft(key);
      const editor = this.readDraft(workspace, chat);
      this.emit({ type: "accepted", message: { role: "user", text }, sessionId: writer.id,
        requestId: submission?.requestId, turnId,
        draft: warning ? { ...editor, warning } : editor });
      mayHaveWritten = false;
      return await this.run(workspace, chat, writer, signal, submission && turnId ? { turnId, requestId: submission.requestId } : undefined);
    } catch (error) {
      if (mayHaveWritten) {
        this.emit({ type: "draft-pending", key });
      } else if (this.drafts.read(key).pending) {
        try {
          this.drafts.write(key, { ...draft, pending: false });
        } catch (draftError) {
          this.emit({ type: "draft-pending", key });
          this.emit({ type: "draft-error", key, message: `Could not save draft: ${String(draftError)}` });
        }
      }
      throw error;
    } finally {
      if (writer?.header.version === 2) writer.close();
    }
  }

  private clearAcceptedDraft(key: string): string | undefined {
    try {
      this.drafts.write(key, { text: "", pending: false });
      return undefined;
    } catch (error) {
      this.drafts.edit(key, "");
      return `Message saved. Could not clear the saved draft: ${String(error)}`;
    }
  }

  private readSubmissionSession(workspace: Workspace, id: string): LoadedSession | undefined {
    const file = join(sessionsDir(workspace.root, this.home), `${id}.jsonl`);
    return existsSync(file) ? resumeSession({ cwd: workspace.root, home: this.home, id }) : undefined;
  }

  private findAcceptedDraft(workspace: Workspace, draft: Draft): LoadedSession | undefined {
    if (!draft.pending || !draft.submission) return undefined;
    const session = this.readSubmissionSession(workspace, draft.submission.sessionId);
    const receipt = session?.submissions.get(draft.submission.requestId);
    return receipt?.text === draft.text.trim() ? session : undefined;
  }

  private refresh(chat: Chat, session: LoadedSession): void {
    chat.saved = session;
    chat.messages = [chat.messages[0]!, ...session.messages];
    if (latestRuntimeNotice(session.messages)?.content !== chat.notice.content) chat.messages.push(chat.notice);
  }

  private async run(workspace: Workspace, chat: Chat, writer: SessionWriter, signal: AbortSignal,
    turn?: { turnId: string; requestId: string; reviewOnly?: boolean; reviewConfirmed?: boolean }): Promise<DesktopState> {
    let dispatching: Pick<ActiveTool, "callId" | "summary"> | undefined;
    try {
      if (turn) {
        const { turnId, requestId, reviewOnly, reviewConfirmed } = turn;
        const runId = writer.startRun(turnId, { reviewOnly, reviewConfirmed });
        const run: RunDisplay = { sessionId: writer.id, requestId, turnId, runId,
          status: "running", continuable: false, needsReview: Boolean(reviewOnly) };
        this.active = { writer, run, phase: "model" };
        this.emit({ type: "run", run });
      }
      for await (const event of runAgent({
        provider: chat.provider, model: chat.config.model, tools: workspace.tools,
        messages: chat.messages, context: { root: workspace.root }, permissions: chat.permissions,
        contextBudget: chat.config.context, signal,
        useProviderEstimate: Boolean(chat.config.modelSelection?.tier),
        preserveFittingInitialHistory: chat.preserveFittingHistory,
        recoveryReadOnly: turn?.reviewOnly,
        requireCompleteResponse: Boolean(turn),
        beforeTool: turn ? (call, mutable) => {
          this.active!.phase = "storage";
          writer.beforeTool(call, mutable);
          this.active!.phase = "tool";
          if (dispatching) this.startTool(dispatching);
          dispatching = undefined;
        } : undefined,
        approve: (request) => {
          if (this.active) this.active.phase = "approval";
          return this.requestApproval(request);
        },
      })) {
        if (event.type === "reasoning-delta") {
          this.emit({ type: "reasoning", delta: event.delta });
          continue;
        }
        if (event.type === "turn-start" && this.active) this.active.phase = "model";
        if (event.type === "retry-wait") this.emit({ ...event, type: "retry" });
        if (event.type === "tool-start") {
          const tool = { callId: event.call.id, summary: event.summary };
          if (turn) dispatching = tool;
          else this.startTool(tool);
        }
        try { persist(writer.recordEvent(event, chat.messages)); }
        catch (error) {
          if (this.active) this.active.phase = "storage";
          throw error;
        }
        if (event.type === "text-delta") this.emit({ type: "text", delta: event.delta });
        if (event.type === "assistant-done") this.emit({ type: "answer", text: event.content });
        if (event.type === "tool-end") {
          this.preparingTool = false;
          this.activeTool = undefined;
          const status = event.denied ? "denied" : signal.aborted && event.isError ? "stopped" : undefined;
          this.emit({ type: "tool", callId: event.call.id, summary: event.summary, content: event.result.content,
            isError: event.isError, ...(!event.denied ? { durationMs: event.durationMs } : {}), ...(status ? { status } : {}) });
        }
        if (event.type === "max-turns") {
          if (!this.active) throw new Error("The agent reached its turn limit.");
          persist(writer.endRun("limit-reached", "limit-reached", this.active.phase));
        }
      }
      if (this.active?.run.stopRequested) persist(writer.endRun("stopped", this.active.run.stopRequested, this.active.phase));
    } catch (error) {
      if (this.active) {
        const { run, phase } = this.active;
        const saveError = writer.endRun(run.stopRequested ? "stopped" : "failed", run.stopRequested ??
          (phase === "storage" ? "storage-error" : phase === "tool" ? "tool-error" : "provider-error"), phase);
        if (saveError) this.emit({ type: "draft-error", key: this.draftKey(workspace, chat), message: `Could not record run status: ${saveError.message}` });
      }
      if (!signal.aborted) throw error;
    } finally {
      chat.preserveFittingHistory = false;
      this.preparingTool = false;
      if (this.activeTool) {
        const { callId } = this.activeTool;
        this.activeTool = undefined;
        this.emit({ type: "tool-interrupted", callId });
      }
      try {
        // Refresh both the provider context and the saved UI metadata.
        const session = loadSession(writer.file);
        this.refresh(chat, session);
        const run = projectRun(session);
        if (run) this.emit({ type: "run", run });
      } catch (error) {
        this.emit({ type: "draft-error", key: this.draftKey(workspace, chat), message: `Could not refresh conversation history: ${String(error)}` });
      }
    }
    return this.snapshot(workspace, chat);
  }

  private persistMode(chat: Chat, writer: SessionWriter, notice: Message, mode: PermissionPreset): void {
    persist(writer.appendPolicy(mode));
    if (latestRuntimeNotice(chat.saved?.messages ?? [])?.content !== notice.content) persist(writer.appendMessage(notice));
    if (chat.recordMode && chat.config.modelSelection) persist(writer.appendModelSelection(chat.config.modelSelection));
    chat.recordMode = false;
  }

  private requestApproval(request: ApprovalRequest): Promise<ApprovalOutcome> {
    return new Promise((resolve) => {
      const id = randomUUID();
      const event: ApprovalEvent = { type: "approval", id, ...describeApproval(request) };
      this.preparingTool = false;
      this.approval = { event, resolve };
      this.emit(event);
    });
  }

  approve(id: string, allowed: boolean): void {
    const pending = this.approval;
    if (!pending || pending.event.id !== id) throw new Error("This approval is no longer active.");
    this.approval = undefined;
    this.preparingTool = allowed;
    this.emit({ type: "approval-closed", id, ...(allowed ? { preparing: true } : {}) });
    pending.resolve(allowed ? "allow" : "deny");
  }

  private startTool(tool: Pick<ActiveTool, "callId" | "summary">): void {
    this.preparingTool = false;
    this.activeTool = { ...tool, startedAt: Date.now() };
    this.emit({ type: "tool-start", ...this.activeTool });
  }

  stop(runId?: string, reason: StopCause = "user-stop"): void {
    const active = this.active;
    if ((runId !== undefined && active?.run.runId !== runId) || (active && !active.writer.hasActiveRun)) return;
    if (!this.controller || this.controller.signal.aborted) return;
    this.controller.abort();
    if (active) {
      active.run = { ...active.run, status: "stopping", stopRequested: reason };
      const error = active.writer.stopRequested(reason);
      this.emit({ type: "run", run: active.run });
      if (error) {
        const { workspace, chat } = this.current();
        this.emit({ type: "draft-error", key: this.draftKey(workspace, chat), message: `Could not record stop request: ${error.message}` });
      }
    }
    if (this.approval) this.approve(this.approval.event.id, false);
  }

  async dispose(): Promise<void> {
    this.stop(undefined, "host-shutdown");
    await this.running?.catch(() => {});
    await this.opening?.catch(() => {});
    try {
      this.drafts.close();
    } finally {
      await this.workspace?.prepared.close();
    }
  }

  private current(): { workspace: Workspace; chat: Chat } {
    if (!this.workspace || !this.chat) throw new Error("Open a workspace first.");
    return { workspace: this.workspace, chat: this.chat };
  }

  private requireIdle(): void {
    if (this.running || this.opening) throw new Error("Wait for the current operation to finish.");
  }

  private draftKey(workspace: Workspace, chat: Chat): string {
    return createHash("sha256").update(JSON.stringify([workspaceKey(workspace.root), chat.sessionId])).digest("hex");
  }

  private readDraft(workspace: Workspace, chat: Chat): DesktopDraft {
    const key = this.draftKey(workspace, chat);
    try {
      const draft = this.drafts.read(key);
      if (draft.pending && draft.submission) {
        let accepted;
        try { accepted = this.findAcceptedDraft(workspace, draft); }
        catch { return { key, text: draft.text, pending: true, warning: "Could not verify the original submission." }; }
        if (accepted) {
          const warning = this.clearAcceptedDraft(key);
          return { key, text: "", pending: false, warning };
        }
      }
      return { key, text: draft.text, pending: draft.pending };
    } catch (error) {
      return { key, text: "", pending: false, warning: `Could not read saved draft: ${String(error)}` };
    }
  }

  private snapshot(workspace: Workspace, chat: Chat, stored = chat.saved): DesktopState {
    let run = projectRun(stored);
    const ownRun = this.active?.writer.hasActiveRun && stored?.file === this.active.writer.file;
    if (stored && run && !ownRun) {
      try {
        if (!hasSessionLocks()) throw new Error("Session locking is unavailable.");
        if (run.status === "interrupted" && stored.runs.some(({ end }) => !end) && sessionWriterBusy(stored.file)) {
          run = { ...run, status: "in-use", continuable: false, needsReview: false };
        }
      } catch {
        run = { ...run, status: "read-only", continuable: false };
      }
    }
    const liveRunId = ownRun || run?.status === "in-use" ? run?.runId : undefined;
    let calls: ToolCall[] | undefined;
    const transcript = (stored?.messages ?? chat.messages)
      .flatMap((message, index): DesktopState["messages"] => {
        if (message.role === "assistant") calls = message.toolCalls;
        if (message.role === "tool") {
          const ui = stored?.toolUi.get(index);
          if (liveRunId && ui?.recovery && ui.reviewRunId === liveRunId && stored?.recoveryNeeded) return [];
          const summary = ui?.summary ?? calls?.find(({ id }) => id === message.toolCallId)?.name ?? "Tool result";
          const status: ToolDisplay["status"] = ui?.denied ? "denied" :
            ui?.recovery === "not-started" ? "not-started" :
            ui?.recovery ? "interrupted" : undefined;
          return [{ role: "tool", summary, text: message.content,
            isError: ui?.isError ?? message.isError ?? false,
            ...(ui && !ui.denied && !ui.recovery ? { durationMs: ui.durationMs } : {}),
            ...(status === undefined ? {} : { status }) }];
        }
        return (message.role === "user" || message.role === "assistant") && !isRuntimeNotice(message) && message.content
          ? [{ role: message.role, text: message.content }] : [];
      });
    return {
      root: workspace.root,
      model: chat.config.model,
      expandReasoning: chat.config.showReasoning,
      mode: chat.permissions.preset === "plan" ? "plan" : "ask",
      sessionId: chat.sessionId,
      draft: this.readDraft(workspace, chat),
      run,
      sessions: listSessions(sessionsDir(workspace.root, this.home)).map(({ id, preview }) => ({ id, title: preview })),
      messages: transcript,
    };
  }
}
