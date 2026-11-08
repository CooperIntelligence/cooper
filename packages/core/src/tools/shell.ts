import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { z } from "zod";
import { resolveInRoot } from "./paths.js";
import type { Tool, ToolResult } from "./tool.js";

const MAX_STREAM_CHARS = 60_000;
const MAX_OUTPUT_CHARS = 30_000;

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
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<ToolResult> {
  return new Promise((resolvePromise) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let finished = false;

    let child;
    try {
      child = spawn(command, {
        cwd,
        shell: true,
        windowsHide: true,
        detached: process.platform !== "win32",
        env: process.env,
      });
    } catch (error) {
      resolvePromise({
        content: `Error: failed to start command: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      });
      return;
    }

    const timer = setTimeout(() => {
      if (finished) return;
      timedOut = true;
      if (child.pid !== undefined) killProcessTree(child.pid);
      else child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = appendCapped(stdout, chunk.toString("utf8"));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = appendCapped(stderr, chunk.toString("utf8"));
    });

    child.on("error", (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolvePromise({
        content: `Error: failed to run command: ${error.message}`,
        isError: true,
      });
    });

    child.on("close", (code, signal) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);

      const sections: string[] = [];
      if (timedOut) {
        sections.push(`Command timed out after ${timeoutMs}ms and was killed.`);
      }
      sections.push(
        `exit code: ${code ?? "unknown"}${signal ? ` (signal ${signal})` : ""}`,
      );
      if (stdout.trim().length > 0) sections.push(stdout.trimEnd());
      if (stderr.trim().length > 0) sections.push(`[stderr]\n${stderr.trimEnd()}`);
      if (stdout.trim().length === 0 && stderr.trim().length === 0) {
        sections.push("(no output)");
      }

      resolvePromise({
        content: truncateOutput(sections.join("\n\n")),
        isError: timedOut || code !== 0,
      });
    });
  });
}

const runCommandSchema = z.object({
  command: z.string().describe("Shell command to execute."),
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

export const runCommandTool: Tool<typeof runCommandSchema> = {
  name: "run_command",
  description:
    "Run a shell command in the workspace (builds, tests, git, scripts). Returns combined output and the exit code. Commands require user approval.",
  inputSchema: runCommandSchema,
  capabilities: ["execute"],
  summarize(input) {
    const where = input.cwd ? `  (in ${input.cwd})` : "";
    return `$ ${input.command}${where}`;
  },
  async execute(input, ctx) {
    const cwd = resolveInRoot(ctx.root, input.cwd ?? ".");
    const stat = await fs.stat(cwd).catch(() => null);
    if (!stat || !stat.isDirectory()) {
      throw new Error(`Not a directory: ${input.cwd ?? "."}`);
    }
    return runProcess(input.command, cwd, input.timeout_ms ?? 120_000);
  },
};
