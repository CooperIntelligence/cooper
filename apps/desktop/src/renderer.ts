import type { ActiveTool, ChatMessage, DesktopApi, DesktopDraft, DesktopEvent, DesktopMode, DesktopState, RunDisplay, ToolDisplay } from "./ipc.js";
import { renderMarkdown } from "./markdown.js";

declare global {
  interface Window { cooper: DesktopApi }
}

function element<T extends HTMLElement>(id: string): T {
  const target = document.getElementById(id);
  if (!target) throw new Error(`Missing desktop element ${id}`);
  return target as T;
}

const api = window.cooper;
const openButton = element<HTMLButtonElement>("open-workspace");
const newButton = element<HTMLButtonElement>("new-chat");
const sendButton = element<HTMLButtonElement>("send");
const stopButton = element<HTMLButtonElement>("stop");
const approvalStopButton = element<HTMLButtonElement>("stop-approval");
const allowButton = element<HTMLButtonElement>("allow");
const denyButton = element<HTMLButtonElement>("deny");
const mode = element<HTMLSelectElement>("mode");
const sendShortcut = element<HTMLSelectElement>("send-shortcut");
const composer = element<HTMLFormElement>("composer");
const prompt = element<HTMLTextAreaElement>("prompt");
const pendingDraft = element("pending-draft");
const keepEditingButton = element<HTMLButtonElement>("keep-editing");
const sessions = element("sessions");
const messages = element("messages");
const conversation = element("conversation");
const approval = element("approval");
const activity = element("activity");
const errorBox = element("error");
const runStatus = element("run-status");
const runDetail = element("run-detail");
const continueButton = element<HTMLButtonElement>("continue-turn");

const sendShortcutKey = "cooper.desktop.sendShortcut";
const savedShortcut = localStorage.getItem(sendShortcutKey);
if (savedShortcut && Array.from(sendShortcut.options).some((option) => option.value === savedShortcut)) {
  sendShortcut.value = savedShortcut;
}
sendShortcut.addEventListener("change", () => localStorage.setItem(sendShortcutKey, sendShortcut.value));

let state: DesktopState | null = null;
let liveAnswer: { row: HTMLElement; text: string; timer?: ReturnType<typeof setTimeout> } | undefined;
let liveReasoning: Text | undefined;
let liveTool: (ActiveTool & { card: ToolCard; timer: ReturnType<typeof setInterval> }) | undefined;
let pendingApproval: string | undefined;
let preparingTool = false;
let working = false;
let reattached = false;
let running = false;
let displayedRun: RunDisplay | undefined;
let retryStatus = "";

function scrollToEnd(): void {
  conversation.scrollTop = conversation.scrollHeight;
}

function isFollowing(): boolean {
  return conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight <= 24;
}

function showError(error: unknown): void {
  errorBox.textContent = error instanceof Error ? error.message : String(error);
  errorBox.hidden = false;
}

function updateControls(): void {
  openButton.disabled = working;
  newButton.disabled = working || state === null;
  for (const button of sessions.querySelectorAll("button")) button.disabled = working;
  const readOnly = displayedRun?.status === "in-use" || displayedRun?.status === "read-only";
  mode.disabled = working || readOnly || state === null;
  prompt.disabled = working || state === null;
  prompt.readOnly = state?.draft.pending ?? false;
  sendButton.disabled = working || readOnly || state === null || prompt.readOnly || Boolean(displayedRun?.needsReview);
  pendingDraft.hidden = !prompt.readOnly;
  keepEditingButton.disabled = working;
  stopButton.hidden = !running;
  composer.hidden = pendingApproval !== undefined;
  const stopping = displayedRun?.status === "stopping";
  stopButton.disabled = stopping;
  approvalStopButton.disabled = stopping;
  activity.textContent = pendingApproval ? "Approval required" :
    stopping ? "Stopping…" :
    liveTool ? "Running tool…" :
    preparingTool ? "Checking approval…" :
    retryStatus || (running ? "Working…" : "");
  const recoverable = displayedRun?.continuable;
  runStatus.hidden = !displayedRun || displayedRun.status === "running" || (displayedRun.status === "completed" && !recoverable);
  continueButton.hidden = !recoverable;
  continueButton.disabled = working;
  if (displayedRun) {
    const { status, reason, stopRequested, needsReview, reviewed } = displayedRun;
    runDetail.textContent = reviewed ? "Recovery check finished. Confirm the findings before continuing." :
      needsReview && recoverable ? "Some tool outcomes could not be verified. Run a read-only check before continuing." :
      status === "interrupted" && stopRequested ?
        (stopRequested === "user-stop" ? "User requested a stop. The run did not record an end." : "Cooper began shutting down. The run did not record an end.") :
      status === "interrupted" ? "Interrupted. End reason unknown." :
      status === "in-use" ? "Another Cooper window is using this conversation. Reopen it to refresh." :
      status === "read-only" ? "The conversation lock is unavailable. This conversation can be viewed only." :
      status === "stopped" ? (reason === "host-shutdown" ? "Stopped when Cooper closed." : "Stopped by the user.") :
      status === "pending" ? "Message saved. The run has not started." :
      status === "limit-reached" ? "The agent reached its turn limit." :
      status === "failed" ? "Run failed." : stopping ? "Stopping…" : "";
    continueButton.textContent = reviewed ? "Confirm and continue" : needsReview ? "Review interrupted tools" : "Continue";
  }
}

function displayDraft(draft: DesktopDraft): void {
  prompt.value = draft.text;
  if (draft.warning) showError(draft.warning);
}

function saveCurrentDraft(): void {
  const draft = state?.draft;
  if (draft && !draft.pending) void api.saveDraft(draft.key, prompt.value).catch(showError);
}

function addMessage({ role, text }: ChatMessage): HTMLElement {
  const row = document.createElement("div");
  row.className = "message " + role;
  if (role === "assistant") row.innerHTML = renderMarkdown(text);
  else row.textContent = text;
  messages.append(row);
  element("empty").hidden = true;
  scrollToEnd();
  return row;
}

function appendAnswer(delta: string): void {
  if (!delta) return;
  const answer = liveAnswer ??= { row: addMessage({ role: "assistant", text: "" }), text: "" };
  answer.text += delta;
  answer.timer ??= setTimeout(() => {
    answer.timer = undefined;
    const follow = isFollowing();
    answer.row.innerHTML = renderMarkdown(answer.text);
    if (follow) scrollToEnd();
  }, 80);
}

function finishAnswer(text?: string): void {
  const answer = liveAnswer;
  liveAnswer = undefined;
  if (!answer) {
    if (text) addMessage({ role: "assistant", text });
    return;
  }
  clearTimeout(answer.timer);
  const follow = isFollowing();
  const content = text ?? answer.text;
  if (content) answer.row.innerHTML = renderMarkdown(content);
  else answer.row.remove();
  if (follow) scrollToEnd();
}

type ToolCard = {
  details: HTMLDetailsElement;
  status: HTMLSpanElement;
  duration: HTMLSpanElement;
  content: HTMLPreElement;
};

function addToolCard(label: string): ToolCard {
  const details = document.createElement("details");
  details.className = "tool";
  const summary = document.createElement("summary");
  const heading = document.createElement("span");
  heading.className = "tool-heading";
  const description = document.createElement("span");
  description.className = "tool-label";
  description.textContent = label;
  const status = document.createElement("span");
  status.className = "tool-state";
  const duration = document.createElement("span");
  duration.className = "tool-duration";
  duration.setAttribute("aria-hidden", "true");
  const content = document.createElement("pre");
  heading.append(description, status, duration);
  summary.append(heading);
  details.append(summary, content);
  messages.append(details);
  element("empty").hidden = true;
  scrollToEnd();
  return { details, status, duration, content };
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
}

function addTool(result: ToolDisplay, card = addToolCard(result.summary)): void {
  const statuses = { denied: "Denied", stopped: "Stopped", interrupted: "Result unknown", "not-started": "Not run" };
  card.details.classList.remove("executing");
  card.details.classList.toggle("failure", result.isError);
  card.status.textContent = result.status ? statuses[result.status] : result.isError ? "Failed" : "Completed";
  const durationMs = result.durationMs ?? 0;
  card.duration.textContent = durationMs < 1000 ? "" : formatDuration(durationMs);
  card.content.hidden = !result.text;
  card.content.textContent = result.text;
}

function clearActiveTool(): ToolCard | undefined {
  if (!liveTool) return undefined;
  const { card, timer } = liveTool;
  clearInterval(timer);
  liveTool = undefined;
  return card;
}

function showActiveTool(tool: ActiveTool): void {
  if (liveTool?.callId === tool.callId) return;
  clearActiveTool();
  const card = addToolCard(tool.summary);
  card.details.classList.add("executing");
  card.status.textContent = "Running";
  card.content.hidden = true;
  const update = () => { card.duration.textContent = formatDuration(Date.now() - tool.startedAt); };
  update();
  liveTool = { ...tool, card, timer: setInterval(update, 1000) };
}

function showInterruptedTool(): void {
  const tool = liveTool;
  if (!tool) return;
  addTool({ role: "tool", summary: tool.summary, text: "The run ended before a tool result was recorded.",
    status: "interrupted", isError: true }, clearActiveTool());
}

function appendReasoning(delta: string): void {
  if (!delta) return;
  const follow = isFollowing();
  if (!liveReasoning) {
    const details = document.createElement("details");
    details.className = "reasoning";
    details.open = state?.expandReasoning ?? false;
    const summary = document.createElement("summary");
    summary.textContent = "Reasoning";
    const content = document.createElement("pre");
    content.setAttribute("aria-live", "off");
    liveReasoning = document.createTextNode("");
    content.append(liveReasoning);
    details.append(summary, content);
    messages.insertBefore(details, liveAnswer?.row ?? null);
  }
  liveReasoning.appendData(delta);
  if (follow) scrollToEnd();
}

function displayState(next: DesktopState, resetConversation: boolean): void {
  state = next;
  displayedRun = next.run;
  const workspacePath = element("workspace-path");
  workspacePath.hidden = false;
  workspacePath.title = next.root;
  workspacePath.textContent = next.root;
  element("model").textContent = next.model;
  mode.value = next.mode;
  const active = next.sessions.find(({ id }) => id === next.sessionId);
  const title = element("conversation-title");
  title.textContent = active?.title ?? "New conversation";
  title.title = active?.title ?? "";
  sessions.replaceChildren(...next.sessions.map(({ id, title }) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = title;
    button.title = title;
    if (id === next.sessionId) button.setAttribute("aria-current", "true");
    button.addEventListener("click", () => { void transition(() => api.restoreSession(id)); });
    return button;
  }));
  if (resetConversation) {
    displayDraft(next.draft);
    messages.replaceChildren();
    clearTimeout(liveAnswer?.timer);
    liveAnswer = undefined;
    liveReasoning = undefined;
    clearActiveTool();
    for (const message of next.messages) {
      if (message.role === "tool") addTool(message);
      else addMessage(message);
    }
    const empty = element("empty");
    empty.hidden = next.messages.length > 0 || next.activeTool !== undefined;
    empty.querySelector("p")!.textContent = "Start a conversation.";
    preparingTool = Boolean(next.preparingTool);
    if (next.activeTool) showActiveTool(next.activeTool);
    scrollToEnd();
  }
}

async function transition(operation: () => Promise<DesktopState | null>, resetConversation = true): Promise<void> {
  if (working) return;
  const focusPrompt = running;
  working = true;
  errorBox.hidden = true;
  updateControls();
  try {
    const next = await operation();
    if (next) {
      displayState(next, resetConversation);
      if (focusPrompt) displayDraft(next.draft);
    }
  } catch (error) {
    showError(error);
    if (state) mode.value = state.mode;
  } finally {
    working = false;
    running = false;
    retryStatus = "";
    preparingTool = false;
    finishAnswer();
    showInterruptedTool();
    liveReasoning = undefined;
    updateControls();
    if (focusPrompt && !prompt.disabled && !prompt.readOnly) prompt.focus();
  }
}

function receive(event: DesktopEvent): void {
  switch (event.type) {
    case "reconciled":
      displayState(event.state, true);
      break;
    case "run":
      displayedRun = event.run;
      if (event.run.status !== "running") retryStatus = "";
      break;
    case "run-settled":
      if (reattached) {
        reattached = false;
        working = false;
        running = false;
        void transition(() => api.getState());
      }
      break;
    case "retry":
      retryStatus = `Reconnecting… attempt ${event.attempt}/${event.maxAttempts}`;
      break;
    case "accepted": {
      if (!state) break;
      const existing = state.sessions.find(({ id }) => id === event.sessionId);
      const active = existing ?? { id: event.sessionId, title: event.message.text.replace(/\s+/g, " ").slice(0, 72) };
      const sessions = [active, ...state.sessions.filter(({ id }) => id !== active.id)];
      displayState({ ...state, sessionId: event.sessionId, sessions, draft: event.draft }, false);
      displayDraft(event.draft);
      addMessage(event.message);
      break;
    }
    case "draft-pending":
      if (state?.draft.key === event.key) state.draft.pending = true;
      break;
    case "draft-error":
      if (state?.draft.key === event.key) showError(event.message);
      break;
    case "text":
      retryStatus = "";
      appendAnswer(event.delta);
      break;
    case "reasoning":
      retryStatus = "";
      appendReasoning(event.delta);
      break;
    case "answer":
      retryStatus = "";
      finishAnswer(event.text);
      liveReasoning = undefined;
      break;
    case "tool-start":
      preparingTool = false;
      showActiveTool(event);
      break;
    case "tool":
      preparingTool = false;
      addTool({ role: "tool", summary: event.summary, text: event.content, isError: event.isError,
        durationMs: event.durationMs, status: event.status }, liveTool?.callId === event.callId ? clearActiveTool() : undefined);
      break;
    case "tool-interrupted":
      if (liveTool?.callId === event.callId) showInterruptedTool();
      break;
    case "approval":
      preparingTool = false;
      pendingApproval = event.id;
      element("approval-title").textContent = event.title;
      element("approval-preview").textContent = event.preview;
      approval.hidden = false;
      allowButton.disabled = false;
      denyButton.disabled = false;
      denyButton.focus({ preventScroll: true });
      break;
    case "approval-closed":
      if (pendingApproval === event.id) {
        pendingApproval = undefined;
        approval.hidden = true;
        preparingTool = Boolean(event.preparing);
      }
      break;
  }
  updateControls();
}

async function approve(allowed: boolean): Promise<void> {
  if (!pendingApproval) return;
  allowButton.disabled = true;
  denyButton.disabled = true;
  try {
    await api.approve(pendingApproval, allowed);
  } catch (error) {
    showError(error);
  }
}

messages.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target.closest("a[href]") : null;
  if (!(target instanceof HTMLAnchorElement)) return;
  event.preventDefault();
  void api.openLink(target.href).catch(showError);
});

openButton.addEventListener("click", () => { void transition(() => api.openWorkspace()); });
newButton.addEventListener("click", () => { void transition(() => api.newChat()); });
mode.addEventListener("change", () => { void transition(() => api.setMode(mode.value as DesktopMode), false); });
allowButton.addEventListener("click", () => { void approve(true); });
denyButton.addEventListener("click", () => { void approve(false); });
for (const button of [stopButton, approvalStopButton]) {
  button.addEventListener("click", () => {
    const runId = displayedRun?.status === "running" ? displayedRun.runId : undefined;
    void api.stop(runId).catch(showError);
  });
}
continueButton.addEventListener("click", () => {
  const run = displayedRun;
  if (!run?.continuable || working) return;
  running = true;
  void transition(() => api.continueTurn(run.turnId, run.reviewed), false);
});
keepEditingButton.addEventListener("click", () => {
  const draft = state?.draft;
  if (!draft?.pending) return;
  void transition(() => api.keepEditingDraft(draft.key)).then(() => {
    if (!prompt.disabled && !prompt.readOnly) prompt.focus();
  });
});
prompt.addEventListener("input", saveCurrentDraft);
composer.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = prompt.value;
  if (!text.trim() || sendButton.disabled) return;
  running = true;
  void transition(() => api.send(text), false);
});
prompt.addEventListener("keydown", (event) => {
  // Some IMEs report 229 for the key that commits the candidate.
  if (event.key !== "Enter" || event.isComposing || event.keyCode === 229 || event.altKey) return;

  const modified = event.ctrlKey || event.metaKey;
  if (modified && event.shiftKey) return;
  const pressed = modified ? "mod-enter" : event.shiftKey ? "shift-enter" : "enter";
  if (pressed === sendShortcut.value) {
    event.preventDefault();
    if (!event.repeat) composer.requestSubmit();
  } else if (modified) {
    event.preventDefault();
    if (!prompt.readOnly) {
      prompt.setRangeText("\n", prompt.selectionStart, prompt.selectionEnd, "end");
      saveCurrentDraft();
    }
  }
});

const unsubscribe = api.subscribe(receive);
window.addEventListener("beforeunload", unsubscribe, { once: true });
updateControls();
void api.getState().then((current) => {
  if (!current || state) return;
  displayState(current, true);
  reattached = running = working = Boolean(current.running);
  if (current.approval) receive(current.approval);
  updateControls();
}).catch(showError);
