import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  PermissionPolicy, SessionWriter, createSkillTool, diffText, discoverSkills,
  isRuntimeNotice, listSessions, loadProjectInstructions, permissionModeNotice,
  resumeSession, runAgent, sessionsDir,
  type ApprovalOutcome, type ApprovalRequest, type LoadedSession, type Message,
  type PermissionPreset, type Provider, type SkillCatalog, type Tool,
} from "@cooper/core";
import {
  buildSystemPrompt, createProvider, loadConfig, modelBudget, needsResumeBudgetCheck,
  prepareTools, selectModelTier, transitionMessage, type Config, type PreparedTools,
} from "@cooper/host";
import type { DesktopEvent, DesktopMode, DesktopState } from "./ipc.js";

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
  notice: Message;
  recordMode: boolean;
  preserveFittingHistory: boolean;
};

function persist(error: Error | null): void {
  if (error) throw error;
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
    return { title: "Run command", preview: `${preview.shell} · ${preview.cwd}\n\n${preview.command}` };
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
  private approval?: { id: string; resolve(outcome: ApprovalOutcome): void };

  constructor(private readonly emit: (event: DesktopEvent) => void, private readonly home?: string) {}

  async openWorkspace(directory: string): Promise<DesktopState> {
    this.requireIdle();
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
      const chat = this.createChat(workspace);
      const state = this.snapshot(workspace, chat);
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
    const messages: Message[] = [{ role: "system", content: system }, ...(saved?.messages ?? []), notice];
    const provider = createProvider(config);
    const preserveFittingHistory = needsResumeBudgetCheck(config, saved?.modelSelection);
    if (saved && preserveFittingHistory) {
      const budget = modelBudget(config, messages, workspace.tools, provider);
      if (budget.estimated > budget.limit) throw new Error(transitionMessage(config, budget));
    }
    return {
      messages, config, provider, permissions, notice, recordMode: true, preserveFittingHistory,
      writer: saved ? SessionWriter.from(saved) : null,
    };
  }

  newChat(id?: string): DesktopState {
    this.requireIdle();
    const { workspace } = this.current();
    const saved = id === undefined ? undefined : resumeSession({ cwd: workspace.root, home: this.home, id });
    const chat = this.createChat(workspace, saved);
    const state = this.snapshot(workspace, chat);
    this.chat = chat;
    return state;
  }

  setMode(mode: DesktopMode): DesktopState {
    this.requireIdle();
    const { workspace, chat } = this.current();
    if (mode !== chat.permissions.preset) {
      const notice = permissionModeNotice(mode);
      if (chat.writer) {
        this.persistMode(chat, chat.writer, notice, mode);
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
    const controller = new AbortController();
    this.controller = controller;
    const running = this.run(workspace, chat, text, controller.signal);
    this.running = running;
    try {
      return await running;
    } finally {
      this.running = undefined;
      this.controller = undefined;
    }
  }

  private async run(workspace: Workspace, chat: Chat, text: string, signal: AbortSignal): Promise<DesktopState> {
    const writer = chat.writer ?? SessionWriter.create({ cwd: workspace.root, model: chat.config.model, home: this.home });
    chat.writer = writer;
    if (chat.recordMode) {
      this.persistMode(chat, writer, chat.notice, chat.permissions.preset);
    }
    const user: Message = { role: "user", content: text };
    persist(writer.appendMessage(user));
    const system = chat.messages[0]!;
    chat.messages.push(user);
    this.emit({ type: "message", message: { role: "user", text } });
    try {
      for await (const event of runAgent({
        provider: chat.provider, model: chat.config.model, tools: workspace.tools,
        messages: chat.messages, context: { root: workspace.root }, permissions: chat.permissions,
        contextBudget: chat.config.context, signal,
        useProviderEstimate: Boolean(chat.config.modelSelection?.tier),
        preserveFittingInitialHistory: chat.preserveFittingHistory,
        approve: (request) => this.requestApproval(request),
      })) {
        persist(writer.recordEvent(event, chat.messages));
        if (event.type === "text-delta") this.emit({ type: "text", delta: event.delta });
        if (event.type === "assistant-done") this.emit({ type: "answer", text: event.content });
        if (event.type === "tool-end") {
          this.emit({ type: "tool", summary: event.summary, content: event.result.content, isError: event.isError });
        }
        if (event.type === "max-turns") throw new Error("The agent reached its turn limit.");
      }
    } catch (error) {
      // Use the same repaired history on the next send as a reopened session.
      chat.messages = [system, ...resumeSession({ cwd: workspace.root, home: this.home, id: writer.id }).messages];
      if (!signal.aborted) throw error;
    } finally {
      chat.preserveFittingHistory = false;
    }
    return this.snapshot(workspace, chat);
  }

  private persistMode(chat: Chat, writer: SessionWriter, notice: Message, mode: PermissionPreset): void {
    persist(writer.appendPolicy(mode));
    persist(writer.appendMessage(notice));
    if (chat.recordMode && chat.config.modelSelection) persist(writer.appendModelSelection(chat.config.modelSelection));
    chat.recordMode = false;
  }

  private requestApproval(request: ApprovalRequest): Promise<ApprovalOutcome> {
    return new Promise((resolve) => {
      const id = randomUUID();
      this.approval = { id, resolve };
      this.emit({ type: "approval", id, ...describeApproval(request) });
    });
  }

  approve(id: string, allowed: boolean): void {
    const pending = this.approval;
    if (!pending || pending.id !== id) throw new Error("This approval is no longer active.");
    this.approval = undefined;
    this.emit({ type: "approval-closed", id });
    pending.resolve(allowed ? "allow" : "deny");
  }

  stop(): void {
    this.controller?.abort();
    if (this.approval) this.approve(this.approval.id, false);
  }

  async dispose(): Promise<void> {
    this.stop();
    await this.running?.catch(() => {});
    await this.opening?.catch(() => {});
    await this.workspace?.prepared.close();
  }

  private current(): { workspace: Workspace; chat: Chat } {
    if (!this.workspace || !this.chat) throw new Error("Open a workspace first.");
    return { workspace: this.workspace, chat: this.chat };
  }

  private requireIdle(): void {
    if (this.running || this.opening) throw new Error("Wait for the current operation to finish.");
  }

  private snapshot(workspace: Workspace, chat: Chat): DesktopState {
    return {
      root: workspace.root,
      model: chat.config.model,
      mode: chat.permissions.preset === "plan" ? "plan" : "ask",
      sessionId: chat.writer?.id ?? null,
      sessions: listSessions(sessionsDir(workspace.root, this.home)).map(({ id, preview }) => ({ id, title: preview })),
      messages: chat.messages.flatMap((message) =>
        (message.role === "user" || message.role === "assistant") && !isRuntimeNotice(message) && message.content
          ? [{ role: message.role, text: message.content }] : [],
      ),
    };
  }
}
