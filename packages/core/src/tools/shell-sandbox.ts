import type { CommandShell } from "./shell.js";

export type ShellSandboxPlatform = "linux";

export type ShellSandboxRequest = {
  root: string;
  cwd: string;
  kind: CommandShell["kind"];
  executable: string;
  args: readonly string[];
  timeoutMs: number;
  network?: boolean;
};

export type ShellSandboxResult =
  | { kind: "exited"; code: number; stdout: string; stderr: string }
  | { kind: "timed-out"; stdout: string; stderr: string }
  | { kind: "cancelled" };

export type ShellSandbox = (
  request: ShellSandboxRequest,
  signal?: AbortSignal,
) => Promise<ShellSandboxResult>;
