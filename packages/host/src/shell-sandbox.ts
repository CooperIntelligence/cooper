import { spawn } from "node:child_process";
import { promises as fs, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { ShellSandbox, ShellSandboxRequest, ShellSandboxResult } from "@cooper/core";

const executableName = "cooper-shell-sandbox.exe";
const maxReplyBytes = 512 * 1024;
const shutdownGraceMs = 5_000;

const replySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("exited"), code: z.number().int(), stdout: z.string(), stderr: z.string() }),
  z.object({ kind: z.literal("timed-out"), stdout: z.string(), stderr: z.string() }),
  z.object({ kind: z.literal("cancelled") }),
  z.object({ kind: z.literal("error"), message: z.string() }),
]);

const absoluteLocalPath = /^[a-z]:[\\/]/i;

export function windowsShellSandbox(appDirectory: string, options?: { requireExecutable?: boolean }): ShellSandbox | undefined {
  if (process.platform !== "win32") return undefined;
  const executable = process.env.COOPER_SHELL_SANDBOX_EXECUTABLE ?? path.join(appDirectory, executableName);
  if (options?.requireExecutable) {
    try {
      if (!absoluteLocalPath.test(executable) || !statSync(executable).isFile()) return undefined;
    } catch {
      return undefined;
    }
  }
  return (request, signal) => runWindowsShell(executable, request, signal);
}

function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

// MSVC argv quoting, since MXC takes a CreateProcess command line. Never route
// through cmd.exe. PowerShell receives the same argv as the normal shell tool.
function quoteArg(arg: string): string {
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/\\+$/, "$&$&")}"`;
}

function ancestors(directories: readonly string[]): string[] {
  const paths = new Set<string>();
  for (const directory of directories) {
    let current = directory;
    for (let parent = path.dirname(current); parent !== current; parent = path.dirname(current)) {
      paths.add(parent);
      current = parent;
    }
  }
  return [...paths];
}

async function runWindowsShell(
  executable: string,
  request: ShellSandboxRequest,
  signal?: AbortSignal,
): Promise<ShellSandboxResult> {
  if (signal?.aborted) return { kind: "cancelled" };
  if (!absoluteLocalPath.test(executable)) {
    throw new Error("COOPER_SHELL_SANDBOX_EXECUTABLE must be an absolute local path.");
  }
  const helper = await fs.realpath(executable).catch(() => undefined);
  if (!helper) throw new Error("The Cooper Windows shell sandbox executable is missing. No command was started.");
  if (inside(request.root, helper)) throw new Error("The sandbox executable must be installed outside the workspace.");

  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const system32 = path.join(systemRoot, "System32");
  const nodeDirectory = process.env.ProgramFiles
    ? await fs.realpath(path.join(process.env.ProgramFiles, "nodejs")).catch(() => undefined)
    : undefined;
  const shellDirectory = path.dirname(request.executable);
  const tempRoot = await fs.realpath(os.tmpdir());
  const scratch = await fs.mkdtemp(path.join(tempRoot, "cooper-shell-"));
  try {
    const env = Object.entries({
      SystemRoot: systemRoot,
      ComSpec: path.join(system32, "cmd.exe"),
      PATH: [shellDirectory, system32, nodeDirectory].filter(Boolean).join(path.delimiter),
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      LOCALAPPDATA: scratch,
      APPDATA: scratch,
      USERPROFILE: scratch,
      HOME: scratch,
      TEMP: scratch,
      TMP: scratch,
      TMPDIR: scratch,
    });
    const readOnly = nodeDirectory ? [request.root, nodeDirectory] : [request.root];
    const payload = JSON.stringify({
      protocol: 1,
      commandLine: [request.executable, ...request.args].map(quoteArg).join(" "),
      cwd: request.cwd,
      env,
      timeoutMs: request.timeoutMs,
      readOnly,
      readWrite: [scratch],
      denied: [".git", ".cooper", ".env"].map((name) => path.join(request.root, name)),
      // Node and npm stat ancestors during module and workspace discovery.
      enumerate: ancestors([...readOnly, scratch]),
    });
    if (signal?.aborted) return { kind: "cancelled" };
    return await runHelper(helper, payload, request.timeoutMs, signal);
  } finally {
    // Only remove the directory allocated by this call, after the helper has stopped.
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

function runHelper(
  helper: string,
  payload: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ShellSandboxResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(helper, [], { cwd: path.dirname(helper), windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    const stdout: Buffer[] = [];
    let bytes = 0;
    let failure: Error | undefined;
    let watchdog = setTimeout(() => stop("Windows shell sandbox did not respond."), timeoutMs + shutdownGraceMs);

    function stop(message: string): void {
      failure ??= new Error(message);
      child.kill();
    }

    function cancel(): void {
      // EOF requests native job termination. Force-close the helper if it stalls.
      child.stdin.end();
      clearTimeout(watchdog);
      watchdog = setTimeout(() => stop("Windows shell sandbox did not confirm cancellation."), shutdownGraceMs);
    }

    child.stdin.on("error", () => { /* The helper may have already exited. */ });
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxReplyBytes) stop("Windows shell sandbox response was too large.");
      else stdout.push(chunk);
    });
    child.on("error", (error) => { failure ??= error; });
    child.once("close", (code) => {
      clearTimeout(watchdog);
      signal?.removeEventListener("abort", cancel);
      if (failure) return reject(failure);
      if (code !== 0) return reject(new Error(`Windows shell sandbox failed (exit code ${code ?? "unknown"}).`));
      try {
        const reply = replySchema.parse(JSON.parse(Buffer.concat(stdout).toString("utf8")));
        if (reply.kind === "error") return reject(new Error(reply.message));
        resolve(signal?.aborted ? { kind: "cancelled" } : reply);
      } catch {
        reject(new Error("Windows shell sandbox returned an invalid response."));
      }
    });
    child.stdin.write(payload + "\n");
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}
