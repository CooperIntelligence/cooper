import { realpathSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

type Sqlite = { DatabaseSync: typeof DatabaseSync };

function sqlite(): Sqlite | undefined {
  return process.getBuiltinModule("node:sqlite") as Sqlite | undefined;
}

export function hasSessionLocks(): boolean {
  return sqlite() !== undefined;
}

export class SessionBusyError extends Error {
  constructor() {
    super("This conversation is in use by another Cooper writer.");
    this.name = "SessionBusyError";
  }
}

export function sessionWriterBusy(file: string): boolean {
  try {
    acquireSessionLock(file)();
    return false;
  } catch (error) {
    if (error instanceof SessionBusyError) return true;
    throw error;
  }
}

/** The OS releases SQLite's file lock after either close or process exit. */
export function acquireSessionLock(file: string): () => void {
  const binding = sqlite();
  if (!binding) throw new Error("Writing v2 sessions requires Node.js with node:sqlite enabled.");
  const directory = realpathSync(path.dirname(file));
  if (process.platform === "win32" && directory.startsWith("\\\\")) {
    throw new Error("Writing v2 sessions requires local storage.");
  }
  const database = new binding.DatabaseSync(path.join(directory, `${path.basename(file)}.lock.sqlite`));
  try {
    database.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE");
  } catch (error) {
    database.close();
    if ((error as { errcode?: number }).errcode === 5) throw new SessionBusyError();
    throw error;
  }
  return () => database.close();
}
