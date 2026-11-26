import { spawn } from "node:child_process";
import { accessSync, constants, promises as fs, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { cooperHome, resolveSandboxProjectRoot } from "@cooper/core";
import type { CommandShell, ShellSandbox, ShellSandboxPlatform, ShellSandboxRequest, ShellSandboxResult } from "@cooper/core";

const maxReplyBytes = 512 * 1024;
const shutdownGraceMs = 5_000;

const replySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("exited"), code: z.number().int(), stdout: z.string(), stderr: z.string() }),
  z.object({ kind: z.literal("timed-out"), stdout: z.string(), stderr: z.string() }),
  z.object({ kind: z.literal("cancelled") }),
  z.object({ kind: z.literal("error"), message: z.string() }),
]);

export function windowsAgentShell(appDirectory: string): CommandShell | undefined {
  if (process.platform !== "win32") return undefined;
  const executable = path.resolve(appDirectory, "powershell", "pwsh.exe");
  try {
    if (statSync(executable).isFile()) return { kind: "pwsh", executable };
  } catch {
    // Source and npm builds can use the host shell without a bundled runtime.
  }
  return undefined;
}

export const shellSandboxPlatform: ShellSandboxPlatform | undefined =
  process.platform === "linux" ? "linux" : undefined;

/** Only exact, explicitly configured workspaces receive outbound access. */
export function linuxWorkspaceNetwork(root: string, workspaces?: readonly string[]): boolean {
  if (shellSandboxPlatform !== "linux" || !workspaces?.length) return false;
  let workspace: string;
  try { workspace = realpathSync(root); }
  catch { return false; }
  return workspaces.some((entry) => path.resolve(entry) === workspace);
}

export function localShellSandbox(appDirectory: string): ShellSandbox | undefined {
  if (shellSandboxPlatform !== "linux") return undefined;
  const name = "cooper-shell-sandbox";
  for (const executable of [
    path.resolve(appDirectory, "sandbox", `linux-${process.arch}`, name),
    path.resolve(appDirectory, name),
  ]) {
    try {
      if (!statSync(executable).isFile()) continue;
      accessSync(executable, constants.X_OK);
    } catch {
      continue;
    }
    return (request, signal) => runLinuxShell(executable, request, signal);
  }
  return undefined;
}

async function runLinuxShell(
  executable: string,
  request: ShellSandboxRequest,
  signal?: AbortSignal,
): Promise<ShellSandboxResult> {
  if (signal?.aborted) return { kind: "cancelled" };
  const [helper, shell, workspace, cwd, home, temp] = await Promise.all([
    fs.realpath(executable), fs.realpath(request.executable), resolveSandboxProjectRoot(request.root),
    fs.realpath(request.cwd), fs.realpath(os.homedir()), fs.realpath(os.tmpdir()),
  ]);
  const configHome = await fs.realpath(cooperHome()).catch(() => cooperHome());
  if (inside(workspace, helper)
    || !inside(workspace, cwd) || inside(workspace, temp)) {
    throw new Error("Choose a project directory separate from the user profile, Cooper runtime, and system temp directory.");
  }
  const scratch = await fs.mkdtemp(path.join(temp, "cooper-shell-"));
  try {
    const toolPaths = new Set(["/usr/local/bin", "/usr/bin", "/bin"]);
    const readOnly = new Set<string>();
    for (const directory of ["/usr/local", path.dirname(shell), path.dirname(process.execPath)]) {
      const resolved = await fs.realpath(directory).catch(() => undefined);
      if (resolved && !inside(workspace, resolved) && !inside(resolved, workspace) && !inside(resolved, home)
        && !inside(configHome, resolved)) {
        readOnly.add(resolved);
        toolPaths.add(path.join(resolved, "bin"));
        toolPaths.add(resolved);
      }
    }
    const env = Object.entries({
      PATH: [...toolPaths].join(path.delimiter),
      HOME: scratch,
      TMPDIR: scratch,
      XDG_CACHE_HOME: path.join(scratch, "cache"),
      XDG_CONFIG_HOME: path.join(scratch, "config"),
      XDG_DATA_HOME: path.join(scratch, "data"),
      LANG: "C.UTF-8",
    });
    const payload = JSON.stringify({
      protocol: 1,
      argv: [shell, ...request.args],
      cwd,
      env,
      timeoutMs: request.timeoutMs,
      readOnly: [...readOnly],
      readWrite: [workspace, scratch],
      denied: [".git", ".cooper", ".env"].map((name) => path.join(workspace, name)),
      network: request.network === true,
    });
    return await runHelper(helper, payload, request.timeoutMs, signal, { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" });
  } finally {
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function runHelper(
  helper: string,
  payload: string,
  timeoutMs: number,
  signal?: AbortSignal,
  env?: NodeJS.ProcessEnv,
): Promise<ShellSandboxResult> {
  if (signal?.aborted) return Promise.resolve({ kind: "cancelled" });
  return new Promise((resolve, reject) => {
    const child = spawn(helper, [], { cwd: path.dirname(helper), env, windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    const stdout: Buffer[] = [];
    let bytes = 0;
    let failure: Error | undefined;
    let watchdog = setTimeout(() => stop("Shell sandbox did not respond."), timeoutMs + shutdownGraceMs);

    function stop(message: string): void {
      failure ??= new Error(message);
      child.kill();
    }

    function cancel(): void {
      // EOF requests native job termination. Force-close the helper if it stalls.
      child.stdin.end();
      clearTimeout(watchdog);
      watchdog = setTimeout(() => stop("Shell sandbox did not confirm cancellation."), shutdownGraceMs);
    }

    child.stdin.on("error", () => { /* The helper may have already exited. */ });
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxReplyBytes) stop("Shell sandbox response was too large.");
      else stdout.push(chunk);
    });
    child.on("error", (error) => { failure ??= error; });
    child.once("close", (code) => {
      clearTimeout(watchdog);
      signal?.removeEventListener("abort", cancel);
      if (failure) return reject(failure);
      if (code !== 0) return reject(new Error(`Shell sandbox failed (exit code ${code ?? "unknown"}).`));
      try {
        const reply = replySchema.parse(JSON.parse(Buffer.concat(stdout).toString("utf8")));
        if (reply.kind === "error") return reject(new Error(reply.message));
        resolve(signal?.aborted ? { kind: "cancelled" } : reply);
      } catch {
        reject(new Error("Shell sandbox returned an invalid response."));
      }
    });
    child.stdin.write(payload + "\n");
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}
