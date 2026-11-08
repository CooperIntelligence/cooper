import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import {
  DEFAULT_CONTEXT_WINDOW,
  resolveContextWindow,
  type ContextSettings,
  type PermissionPreset,
} from "@cooper/core";

let envLoaded = false;

/** Nearest .env at or above `start`, so the CLI finds its own credentials. */
function findEnvFileUpwards(start: string, levels = 5): string | null {
  let dir = start;
  for (let depth = 0; depth < levels; depth += 1) {
    const candidate = path.join(dir, ".env");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function loadEnvFiles(): void {
  if (envLoaded) return;
  envLoaded = true;

  // Works both when the CLI runs from apps/cli (npm workspace) and from the
  // repository root (tsx apps/cli/src/index.tsx).
  const candidates = [
    path.resolve(process.cwd(), ".env"),
    path.resolve(process.cwd(), "../../.env"),
  ];

  // `--cwd` may point at a project with no .env of its own, so fall back to
  // the one next to the CLI rather than forcing credentials to be copied.
  const cliEnv = findEnvFileUpwards(path.dirname(fileURLToPath(import.meta.url)));
  if (cliEnv !== null) candidates.push(cliEnv);

  // dotenv never overrides existing values, so the first file defining a key
  // wins, and real environment variables always win over any file.
  for (const file of candidates) {
    dotenv.config({ path: file, quiet: true });
  }
}

/** ask: prompt before writes/commands · auto: allow everything · plan: read-only */
export type ApprovalMode = PermissionPreset;

export type Config = {
  apiKey: string;
  baseURL: string | undefined;
  model: string;
  context: ContextSettings;
  /** True when the model was not recognised and a default window was assumed. */
  contextWindowAssumed: boolean;
  /** Stream reasoning text instead of showing only an indicator. */
  showReasoning: boolean;
};

function positiveInt(value: string | undefined, fallback: number): number {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed === "") return fallback;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive number, got "${trimmed}".`);
  }
  return Math.floor(parsed);
}

function envFlag(value: string | undefined, fallback: boolean): boolean {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized === "") return fallback;
  if (["0", "false", "off", "no"].includes(normalized)) return false;
  if (["1", "true", "on", "yes"].includes(normalized)) return true;
  return fallback;
}

export function loadConfig(): Config {
  loadEnvFiles();

  const apiKey = process.env.COOPER_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
  if (!apiKey.trim()) {
    throw new Error(
      "No API key found. Copy .env.example to .env and set COOPER_API_KEY (or OPENAI_API_KEY).",
    );
  }

  const baseURL =
    process.env.COOPER_BASE_URL ?? process.env.OPENAI_BASE_URL ?? undefined;
  const model =
    process.env.COOPER_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-4o-mini";

  const windowOverride = process.env.COOPER_CONTEXT_WINDOW?.trim();
  const resolved =
    windowOverride !== undefined && windowOverride !== ""
      ? { window: positiveInt(windowOverride, DEFAULT_CONTEXT_WINDOW), assumed: false }
      : resolveContextWindow(model);

  const context: ContextSettings = {
    window: resolved.window,
    reserveOutputTokens: positiveInt(
      process.env.COOPER_CONTEXT_RESERVE,
      16_384,
    ),
    summaryModel:
      process.env.COOPER_SUMMARY_MODEL?.trim() || undefined,
    enabled: envFlag(process.env.COOPER_CONTEXT_COMPACT, true),
  };

  return {
    apiKey,
    baseURL,
    model,
    context,
    contextWindowAssumed: resolved.assumed,
    showReasoning: envFlag(process.env.COOPER_SHOW_REASONING, false),
  };
}
