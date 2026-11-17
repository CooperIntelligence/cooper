import type { ChatMessage, DesktopApi, DesktopEvent, DesktopMode, DesktopState } from "./ipc.js";

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
const allowButton = element<HTMLButtonElement>("allow");
const denyButton = element<HTMLButtonElement>("deny");
const mode = element<HTMLSelectElement>("mode");
const sendShortcut = element<HTMLSelectElement>("send-shortcut");
const composer = element<HTMLFormElement>("composer");
const prompt = element<HTMLTextAreaElement>("prompt");
const sessions = element("sessions");
const messages = element("messages");
const conversation = element("conversation");
const approval = element("approval");
const activity = element("activity");
const errorBox = element("error");

const sendShortcutKey = "cooper.desktop.sendShortcut";
const savedShortcut = localStorage.getItem(sendShortcutKey);
if (savedShortcut && Array.from(sendShortcut.options).some((option) => option.value === savedShortcut)) {
  sendShortcut.value = savedShortcut;
}
sendShortcut.addEventListener("change", () => localStorage.setItem(sendShortcutKey, sendShortcut.value));

let state: DesktopState | null = null;
let liveAnswer: HTMLElement | undefined;
let pendingApproval: string | undefined;
let working = false;
let running = false;

function scrollToEnd(): void {
  conversation.scrollTop = conversation.scrollHeight;
}

function showError(error: unknown): void {
  errorBox.textContent = error instanceof Error ? error.message : String(error);
  errorBox.hidden = false;
}

function updateControls(): void {
  openButton.disabled = working;
  newButton.disabled = working || state === null;
  for (const button of sessions.querySelectorAll("button")) button.disabled = working;
  mode.disabled = working || state === null;
  prompt.disabled = working || state === null;
  sendButton.disabled = working || state === null;
  stopButton.hidden = !running;
  activity.textContent = pendingApproval ? "Approval required" : running ? "Working…" : "";
}

function addMessage({ role, text }: ChatMessage): HTMLElement {
  const row = document.createElement("div");
  row.className = "message " + role;
  row.textContent = text;
  messages.append(row);
  element("empty").hidden = true;
  scrollToEnd();
  return row;
}

function displayState(next: DesktopState, resetConversation: boolean): void {
  state = next;
  const workspacePath = element("workspace-path");
  workspacePath.hidden = false;
  workspacePath.title = next.root;
  workspacePath.textContent = next.root;
  element("model").textContent = next.model;
  mode.value = next.mode;
  const active = next.sessions.find(({ id }) => id === next.sessionId);
  element("conversation-title").textContent = active?.title ?? "New conversation";
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
    messages.replaceChildren();
    liveAnswer = undefined;
    for (const message of next.messages) addMessage(message);
    const empty = element("empty");
    empty.hidden = next.messages.length > 0;
    empty.querySelector("p")!.textContent = "Start a conversation.";
    scrollToEnd();
  }
}

async function transition(operation: () => Promise<DesktopState | null>, resetConversation = true): Promise<void> {
  if (working) return;
  working = true;
  errorBox.hidden = true;
  updateControls();
  try {
    const next = await operation();
    if (next) displayState(next, resetConversation);
  } catch (error) {
    showError(error);
    if (state) mode.value = state.mode;
  } finally {
    working = false;
    running = false;
    liveAnswer = undefined;
    updateControls();
  }
}

function receive(event: DesktopEvent): void {
  switch (event.type) {
    case "message":
      addMessage(event.message);
      break;
    case "text":
      liveAnswer ??= addMessage({ role: "assistant", text: "" });
      liveAnswer.append(event.delta);
      scrollToEnd();
      break;
    case "answer":
      if (liveAnswer) liveAnswer.textContent = event.text;
      else if (event.text) addMessage({ role: "assistant", text: event.text });
      liveAnswer = undefined;
      break;
    case "tool": {
      const details = document.createElement("details");
      details.className = event.isError ? "tool failure" : "tool";
      const summary = document.createElement("summary");
      const content = document.createElement("pre");
      summary.textContent = event.summary;
      content.textContent = event.content;
      details.append(summary, content);
      messages.append(details);
      scrollToEnd();
      break;
    }
    case "approval":
      pendingApproval = event.id;
      element("approval-title").textContent = event.title;
      element("approval-preview").textContent = event.preview;
      approval.hidden = false;
      allowButton.disabled = false;
      denyButton.disabled = false;
      denyButton.focus();
      break;
    case "approval-closed":
      if (pendingApproval === event.id) {
        pendingApproval = undefined;
        approval.hidden = true;
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

openButton.addEventListener("click", () => { void transition(() => api.openWorkspace()); });
newButton.addEventListener("click", () => { void transition(() => api.newChat()); });
mode.addEventListener("change", () => { void transition(() => api.setMode(mode.value as DesktopMode), false); });
allowButton.addEventListener("click", () => { void approve(true); });
denyButton.addEventListener("click", () => { void approve(false); });
stopButton.addEventListener("click", () => { void api.stop().catch(showError); });
composer.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = prompt.value.trim();
  if (!text || !state || working) return;
  prompt.value = "";
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
    prompt.setRangeText("\n", prompt.selectionStart, prompt.selectionEnd, "end");
  }
});

const unsubscribe = api.subscribe(receive);
window.addEventListener("beforeunload", unsubscribe, { once: true });
updateControls();
