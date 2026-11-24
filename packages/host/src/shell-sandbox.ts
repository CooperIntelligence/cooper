import { spawn } from "node:child_process";
import { accessSync, constants, promises as fs, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { cooperHome, resolveSandboxProjectRoot } from "@cooper/core";
import type { CommandShell, ShellSandbox, ShellSandboxPlatform, ShellSandboxRequest, ShellSandboxResult } from "@cooper/core";

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

export function windowsAgentShell(appDirectory: string): CommandShell | undefined {
  if (process.platform !== "win32") return undefined;
  return { kind: "pwsh", executable: path.resolve(appDirectory, "powershell", "pwsh.exe") };
}

export function windowsShellSandbox(appDirectory: string): ShellSandbox | undefined {
  const shell = windowsAgentShell(appDirectory);
  if (!shell) return undefined;
  const executable = path.resolve(appDirectory, executableName);
  try {
    for (const required of [executable, shell.executable]) {
      if (!absoluteLocalPath.test(required) || !statSync(required).isFile()) return undefined;
    }
  } catch {
    return undefined;
  }
  return (request, signal) => runWindowsShell(executable, shell.executable, request, signal);
}

export const shellSandboxPlatform: ShellSandboxPlatform | undefined =
  process.platform === "win32" ? "windows" : process.platform === "linux" ? "linux" : undefined;

/** Only exact, explicitly configured workspaces receive outbound access. */
export function linuxWorkspaceNetwork(root: string, workspaces?: readonly string[]): boolean {
  if (shellSandboxPlatform !== "linux" || !workspaces?.length) return false;
  let workspace: string;
  try { workspace = realpathSync(root); }
  catch { return false; }
  return workspaces.some((entry) => path.resolve(entry) === workspace);
}

export function localShellSandbox(appDirectory: string): ShellSandbox | undefined {
  if (shellSandboxPlatform === "windows") return windowsShellSandbox(appDirectory);
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
    fs.realpath(executable), fs.realpath(request.executable), resolveSandboxProjectRoot(request.root, "linux"),
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
  bundledPowerShell: string,
  request: ShellSandboxRequest,
  signal?: AbortSignal,
): Promise<ShellSandboxResult> {
  if (signal?.aborted) return { kind: "cancelled" };
  if (request.kind !== "pwsh" || path.relative(bundledPowerShell, request.executable) !== "") {
    throw new Error("The Windows shell sandbox requires Cooper's bundled PowerShell 7.");
  }
  const [helper, shellExecutable, workspace] = await Promise.all([
    fs.realpath(executable), fs.realpath(bundledPowerShell), resolveSandboxProjectRoot(request.root, "windows"),
  ]);
  const shellDirectory = path.dirname(shellExecutable);
  const appDirectory = path.dirname(helper);
  if (path.relative(path.join(appDirectory, "powershell"), shellDirectory) !== "" ||
      inside(workspace, appDirectory) || inside(appDirectory, workspace)) {
    throw new Error("Windows sandbox runtime files must be in a dedicated installation outside the workspace.");
  }

  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const system32 = path.join(systemRoot, "System32");
  const nodeDirectory = process.env.ProgramFiles
    ? await fs.realpath(path.join(process.env.ProgramFiles, "nodejs")).catch(() => undefined)
    : undefined;
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
    const readOnly = [shellDirectory];
    if (nodeDirectory) readOnly.push(nodeDirectory);
    const readWrite = [workspace, scratch];
    const payload = JSON.stringify({
      protocol: 1,
      commandLine: [shellExecutable, ...request.args].map(quoteArg).join(" "),
      cwd: request.cwd,
      env,
      timeoutMs: request.timeoutMs,
      readOnly,
      readWrite,
      denied: [".git", ".cooper", ".env"].map((name) => path.join(workspace, name)),
      // Node and npm stat ancestors during module and workspace discovery.
      enumerate: ancestors([...readOnly, ...readWrite]),
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
