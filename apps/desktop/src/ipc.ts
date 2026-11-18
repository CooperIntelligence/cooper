export type DesktopMode = "ask" | "plan";
export type ChatMessage = { role: "user" | "assistant"; text: string };
export type ToolDisplay = {
  role: "tool";
  summary: string;
  text: string;
  isError: boolean;
  durationMs?: number;
  status?: "denied" | "stopped" | "interrupted" | "not-started";
};
export type ActiveTool = { callId: string; summary: string; startedAt: number };
export type RunDisplay = {
  sessionId: string;
  requestId: string;
  turnId: string;
  runId?: string;
  status: "pending" | "running" | "in-use" | "read-only" | "stopping" | "completed" | "stopped" | "interrupted" | "failed" | "limit-reached";
  reason?: string;
  stopRequested?: "user-stop" | "host-shutdown";
  continuable: boolean;
  needsReview: boolean;
  reviewed?: boolean;
};
export type DesktopDraft = { key: string; text: string; pending: boolean; warning?: string };
export type ApprovalEvent = { type: "approval"; id: string; title: string; preview: string };
export type DesktopState = {
  root: string;
  model: string;
  expandReasoning: boolean;
  mode: DesktopMode;
  sessionId: string | null;
  sessions: { id: string; title: string }[];
  messages: (ChatMessage | ToolDisplay)[];
  draft: DesktopDraft;
  run?: RunDisplay;
  approval?: ApprovalEvent;
  preparingTool?: boolean;
  activeTool?: ActiveTool;
  running?: boolean;
};

export type DesktopEvent =
  | { type: "accepted"; message: ChatMessage; sessionId: string; requestId?: string; turnId?: string; draft: DesktopDraft }
  | { type: "reconciled"; state: DesktopState }
  | { type: "draft-pending"; key: string }
  | { type: "draft-error"; key: string; message: string }
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "run"; run: RunDisplay }
  | { type: "run-settled" }
  | { type: "retry"; attempt: number; maxAttempts: number; delayMs: number }
  | { type: "answer"; text: string }
  | ({ type: "tool-start" } & ActiveTool)
  | ({ type: "tool"; callId: string; content: string } & Omit<ToolDisplay, "role" | "text">)
  | { type: "tool-interrupted"; callId: string }
  | ApprovalEvent
  | { type: "approval-closed"; id: string; preparing?: boolean };

export type DesktopApi = {
  getState(): Promise<DesktopState | null>;
  openWorkspace(): Promise<DesktopState | null>;
  newChat(): Promise<DesktopState>;
  restoreSession(id: string): Promise<DesktopState>;
  setMode(mode: DesktopMode): Promise<DesktopState>;
  saveDraft(key: string, text: string): Promise<void>;
  keepEditingDraft(key: string): Promise<DesktopState>;
  send(prompt: string): Promise<DesktopState>;
  continueTurn(turnId: string, confirmReview?: boolean): Promise<DesktopState>;
  stop(runId?: string): Promise<void>;
  approve(id: string, allowed: boolean): Promise<void>;
  openLink(url: string): Promise<void>;
  subscribe(listener: (event: DesktopEvent) => void): () => void;
};
