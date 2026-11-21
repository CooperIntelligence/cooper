export type ShellSandboxRequest = {
  root: string;
  cwd: string;
  executable: string;
  args: readonly string[];
  timeoutMs: number;
};

export type ShellSandboxResult =
  | { kind: "exited"; code: number; stdout: string; stderr: string }
  | { kind: "timed-out"; stdout: string; stderr: string }
  | { kind: "cancelled" };

export type ShellSandbox = (
  request: ShellSandboxRequest,
  signal?: AbortSignal,
) => Promise<ShellSandboxResult>;
