export type DesktopMode = "ask" | "plan";
export type ChatMessage = { role: "user" | "assistant"; text: string };
export type DesktopState = {
  root: string;
  model: string;
  mode: DesktopMode;
  sessionId: string | null;
  sessions: { id: string; title: string }[];
  messages: ChatMessage[];
};

export type DesktopEvent =
  | { type: "message"; message: ChatMessage }
  | { type: "text"; delta: string }
  | { type: "answer"; text: string }
  | { type: "tool"; summary: string; content: string; isError: boolean }
  | { type: "approval"; id: string; title: string; preview: string }
  | { type: "approval-closed"; id: string };

export type DesktopApi = {
  openWorkspace(): Promise<DesktopState | null>;
  newChat(): Promise<DesktopState>;
  restoreSession(id: string): Promise<DesktopState>;
  setMode(mode: DesktopMode): Promise<DesktopState>;
  send(prompt: string): Promise<DesktopState>;
  stop(): Promise<void>;
  approve(id: string, allowed: boolean): Promise<void>;
  subscribe(listener: (event: DesktopEvent) => void): () => void;
};
