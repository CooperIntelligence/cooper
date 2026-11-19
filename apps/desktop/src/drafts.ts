import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type Draft = {
  text: string;
  pending: boolean;
  submission?: { sessionId: string; requestId: string };
};

export class DraftStore {
  private readonly edits = new Map<string, Draft>();
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly directory: string,
    private readonly onError?: (key: string, error: unknown) => void,
  ) {}

  read(key: string): Draft {
    const edit = this.edits.get(key);
    if (edit) return edit;
    let contents: string;
    try {
      contents = fs.readFileSync(this.file(key), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { text: "", pending: false };
      throw error;
    }
    const draft = JSON.parse(contents) as Partial<Draft> | null;
    if (typeof draft?.text !== "string" || typeof draft.pending !== "boolean") {
      throw new Error("The saved draft is invalid.");
    }
    const { submission } = draft;
    if (submission && (typeof submission.sessionId !== "string" || typeof submission.requestId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(submission.sessionId) || !/^[a-f0-9-]{36}$/.test(submission.requestId))) {
      throw new Error("The saved submission is invalid.");
    }
    return { text: draft.text, pending: draft.pending, ...(submission ? { submission } : {}) };
  }

  edit(key: string, text: string): void {
    let previous: Draft | undefined;
    try { previous = this.read(key); } catch { /* Explicit edits can replace a damaged draft. */ }
    this.edits.set(key, { text, pending: false, ...(text === previous?.text && previous.submission ? { submission: previous.submission } : {}) });
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      for (const draftKey of this.edits.keys()) {
        try {
          this.flush(draftKey);
        } catch (error) {
          this.onError?.(draftKey, error);
        }
      }
    }, 250);
  }

  flush(key: string): void {
    const draft = this.edits.get(key);
    if (draft) this.write(key, draft);
  }

  close(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    for (const key of this.edits.keys()) this.flush(key);
  }

  write(key: string, draft: Draft): void {
    const file = this.file(key);
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(this.directory, `.${randomUUID()}.tmp`);
    const handle = fs.openSync(temporary, "wx", 0o600);
    try {
      try {
        fs.writeFileSync(handle, JSON.stringify(draft) + "\n", "utf8");
        fs.fsyncSync(handle);
      } finally {
        fs.closeSync(handle);
      }
      fs.renameSync(temporary, file);
    } catch (error) {
      try { fs.unlinkSync(temporary); } catch { /* Keep the original error. */ }
      throw error;
    }
    this.edits.delete(key);
  }

  private file(key: string): string {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Invalid draft key.");
    return path.join(this.directory, `${key}.json`);
  }
}
