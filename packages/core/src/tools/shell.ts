import { spawn, type SpawnOptions } from "node:child_process";
import { accessSync, constants, promises as fs, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { resolveInRoot } from "./paths.js";
import type { Tool, ToolResult } from "./tool.js";

const MAX_STREAM_CHARS = 60_000;
const MAX_OUTPUT_CHARS = 30_000;

export const commandShellKinds = [
  "powershell", "pwsh", "cmd", "sh", "bash", "zsh", "git-bash",
] as const;

export type CommandShell = {
  kind: (typeof commandShellKinds)[number];
  executable: string;
};

const windows = process.platform === "win32";
const windowsDirectory = process.env.SystemRoot || "C:\\Windows";
const system32 = path.join(windowsDirectory, "System32");
const systemPowerShell = path.join(system32, "WindowsPowerShell", "v1.0", "powershell.exe");
const systemCmd = path.join(system32, "cmd.exe");

export function resolveCommandShell(settings?: {
  kind: CommandShell["kind"];
  executable?: string;
}): CommandShell {
  if (settings === undefined) {
    switch (process.platform) {
      case "win32":
        return { kind: "powershell", executable: systemPowerShell };
      case "linux":
        return { kind: "bash", executable: "/bin/bash" };
      case "darwin":
        return { kind: "zsh", executable: "/bin/zsh" };
      default:
        return { kind: "sh", executable: "/bin/sh" };
    }
  }

  const { kind, executable } = settings;
  if (!windows && (kind === "powershell" || kind === "cmd" || kind === "git-bash")) {
    throw new Error(`Command shell "${kind}" is only available on Windows.`);
  }
  if (executable !== undefined && (
    !path.isAbsolute(executable) || (windows && /^[\\/](?![\\/])/.test(executable))
  )) {
    throw new Error("shell.executable must be an absolute path.");
  }
  if (windows && kind === "bash" && executable === undefined) {
    throw new Error('Set an absolute shell.executable for "bash" on Windows, or use "git-bash".');
  }

  let candidates: string[];
  if (executable !== undefined) {
    candidates = [executable];
  } else if (kind === "powershell") {
    candidates = [systemPowerShell];
  } else if (kind === "cmd") {
    candidates = [systemCmd];
  } else if (kind === "sh" && !windows) {
    candidates = ["/bin/sh"];
  } else if (kind === "git-bash") {
    candidates = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]
      .filter((directory): directory is string => directory !== undefined && path.isAbsolute(directory))
      .map((directory) => path.join(directory, "Git", "bin", "bash.exe"));
  } else {
    const name = windows ? `${kind}.exe` : kind;
    candidates = (process.env.PATH ?? "").split(path.delimiter)
      .map((directory) => directory.replace(/^"(.*)"$/, "$1"))
      .filter((directory) => path.isAbsolute(directory))
      .map((directory) => path.join(directory, name));
  }

  for (const candidate of candidates) {
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return { kind, executable: candidate };
    } catch {
      // Continue to the next trusted installation or PATH entry.
    }
  }
  throw new Error(`Command shell "${kind}" was not found${executable ? ` at "${executable}"` : ""}. Check shell in config.json.`);
}

function shellArgs(kind: CommandShell["kind"], command: string): string[] {
  if (kind === "powershell" || kind === "pwsh") {
    const script = [
      "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
      "$OutputEncoding = [Console]::OutputEncoding",
      "$ProgressPreference = 'SilentlyContinue'",
      command,
      "if ($?) { exit 0 }",
      "if ($LASTEXITCODE) { exit $LASTEXITCODE }",
      "exit 1",
    ].join("\n");
    // Windows PowerShell serializes diagnostics as CLIXML with -EncodedCommand.
    // Decode the script inside -Command to keep both quoting and text output.
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const launcher =
      `$cooperCommand = [ScriptBlock]::Create([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encoded}'))); & $cooperCommand`;
    return [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-OutputFormat", "Text",
      "-Command", launcher,
    ];
  }
  if (kind === "bash" || kind === "git-bash") {
    return ["--noprofile", "--norc", "-c", command];
  }
  if (kind === "zsh") return ["-f", "-c", command];
  return ["-c", command];
}

function appendCapped(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length > MAX_STREAM_CHARS
    ? next.slice(-MAX_STREAM_CHARS)
    : next;
}

function truncateOutput(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  const half = Math.floor(MAX_OUTPUT_CHARS / 2);
  return `${text.slice(0, half)}\n\n[… output truncated …]\n\n${text.slice(-half)}`;
}

function commandResult(
  code: number | null,
  stdout: string,
  stderr: string,
  status?: string,
  signal?: NodeJS.Signals | null,
): ToolResult {
  const sections: string[] = [];
  if (status) sections.push(status);
  sections.push(`exit code: ${code ?? "unknown"}${signal ? ` (signal ${signal})` : ""}`);
  if (stdout.trim()) sections.push(stdout.trimEnd());
  if (stderr.trim()) sections.push(`[stderr]\n${stderr.trimEnd()}`);
  if (!stdout.trim() && !stderr.trim()) sections.push("(no output)");
  return { content: truncateOutput(sections.join("\n\n")), isError: status !== undefined || code !== 0 };
}

function killProcessTree(pid: number): void {
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    } catch {
      // Best effort only.
    }
    return;
  }

  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Best effort only.
    }
  }
}

function runProcess(
  shell: CommandShell,
  command: string,
  cwd: string,
  timeoutMs: number,
  abortSignal?: AbortSignal,
): Promise<ToolResult> {
  return new Promise((resolvePromise) => {
    let stdout = "";
    let stderr = "";
    let stopped: "timeout" | "abort" | undefined;
    let finished = false;

    let child;
    try {
      const options: SpawnOptions = {
        cwd,
        windowsHide: true,
        detached: !windows,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      };
      // Node handles cmd.exe's /d /s /c quoting rules.
      child = shell.kind === "cmd"
        ? spawn(command, { ...options, shell: shell.executable })
        : spawn(shell.executable, shellArgs(shell.kind, command), options);
    } catch (error) {
      resolvePromise({
        content: `Error: failed to start command: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      });
      return;
    }

    const stop = (reason: typeof stopped) => {
      if (finished || stopped !== undefined) return;
      stopped = reason;
      if (child.pid !== undefined) killProcessTree(child.pid);
      else child.kill("SIGKILL");
    };
    const abort = () => stop("abort");
    const timer = setTimeout(() => stop("timeout"), timeoutMs);
    const finish = () => {
      finished = true;
      clearTimeout(timer);
      abortSignal?.removeEventListener("abort", abort);
    };

    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      stdout = appendCapped(stdout, chunk);
    });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      stderr = appendCapped(stderr, chunk);
    });

    child.on("error", (error) => {
      if (finished) return;
      finish();
      const detail = (error as NodeJS.ErrnoException).code === "ENOENT"
        ? `Could not launch ${shell.executable} in ${cwd}. Check the working directory and shell setting in config.json.`
        : `Error: failed to run command: ${error.message}`;
      resolvePromise({
        content: detail,
        isError: true,
      });
    });

    child.on("close", (code, signal) => {
      if (finished) return;
      finish();

      const status = stopped === "timeout" ? `Command timed out after ${timeoutMs}ms and was killed.`
        : stopped === "abort" ? "Command cancelled." : undefined;
      resolvePromise(commandResult(code, stdout, stderr, status, signal));
    });
    abortSignal?.addEventListener("abort", abort, { once: true });
    if (abortSignal?.aborted) abort();
  });
}

const runCommandSchema = z.object({
  command: z.string().describe("Shell command to execute."),
  description: z
    .string()
    .trim()
    .min(1, "Explain the command's purpose and main effects for the user.")
    .overwrite((description) => description.replace(/\s+/g, " "))
    .describe("Briefly explain to the user why this command is needed and what it will do. Cover each significant step and side effect of a compound command."),
  cwd: z
    .string()
    .optional()
    .describe("Working directory relative to the workspace root. Defaults to the root."),
  timeout_ms: z
    .number()
    .int()
    .min(1000)
    .max(600_000)
    .optional()
    .describe("Timeout in milliseconds. Defaults to 120000."),
});

export function createRunCommandTool(shell: CommandShell): Tool<typeof runCommandSchema> {
  const shellName = shell.kind === "powershell" ? "Windows PowerShell 5.1"
    : shell.kind === "pwsh" ? "PowerShell (pwsh)" : shell.kind;
  async function resolveCwd(root: string, relative: string): Promise<string> {
    const cwd = await resolveInRoot(root, relative);
    const stat = await fs.stat(cwd).catch(() => null);
    if (!stat?.isDirectory()) throw new Error(`Not a directory: ${relative}`);
    return cwd;
  }
  return {
    name: "shell",
    aliases: ["run_command"],
    description:
      `Run a command in the workspace using ${shellName} on ${process.platform}. ` +
      "Use this shell's syntax. Returns combined output and the exit code. Commands require user approval.",
    inputSchema: runCommandSchema,
    capabilities: ["execute"],
    summarize(input) {
      return `${input.description} · [${shellName} · cwd: ${input.cwd ?? "."}]\n$ ${input.command}`;
    },
    async preview(input, ctx) {
      try {
        const relativeCwd = input.cwd ?? ".";
        const cwd = await resolveCwd(ctx.root, relativeCwd);
        return {
          kind: "command", shell: shellName, executable: shell.executable,
          cwd, command: input.command, description: input.description,
          async revalidate() {
            const current = await resolveCwd(ctx.root, relativeCwd).catch(() => null);
            return current === cwd;
          },
        };
      } catch (error) {
        return { kind: "invalid", reason: error instanceof Error ? error.message : String(error) };
      }
    },
    async execute(input, ctx, approvedPreview) {
      const cwd = await resolveCwd(ctx.root, input.cwd ?? ".");
      if (approvedPreview?.kind === "command" && cwd !== approvedPreview.cwd) {
        throw new Error("Command working directory changed after approval.");
      }
      ctx.signal?.throwIfAborted();
      const timeoutMs = input.timeout_ms ?? 120_000;
      if (ctx.requireShellSandbox) {
        if (!ctx.shellSandbox || (shell.kind !== "powershell" && shell.kind !== "pwsh")) {
          return { content: "AUTO shell requires the Windows PowerShell sandbox. No command was started.", isError: true };
        }
        const root = await fs.realpath(ctx.root);
        const result = await ctx.shellSandbox({
          root, cwd, executable: shell.executable, args: shellArgs(shell.kind, input.command), timeoutMs,
        }, ctx.signal);
        switch (result.kind) {
          case "exited": return commandResult(result.code, result.stdout, result.stderr);
          case "timed-out": return commandResult(null, result.stdout, result.stderr,
            `Command timed out after ${timeoutMs}ms and was killed.`);
          case "cancelled": return commandResult(null, "", "", "Command cancelled.");
        }
      }
      return runProcess(shell, input.command, cwd, timeoutMs, ctx.signal);
    },
  };
}

export const runCommandTool = createRunCommandTool(resolveCommandShell());
