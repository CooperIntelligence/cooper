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

export type ProviderKind = "openai" | "anthropic";

const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";
const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5-5";
export const DEFAULT_MAX_OUTPUT_TOKENS = 64_000;

export type Config = {
  provider: ProviderKind;
  apiKey: string;
  baseURL: string | undefined;
  model: string;
  /** Anthropic `max_tokens`; streaming keeps a high ceiling safe. */
  maxOutputTokens: number;
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

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed !== "" ? trimmed : undefined;
}

function envFlag(value: string | undefined, fallback: boolean): boolean {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized === "") return fallback;
  if (["0", "false", "off", "no"].includes(normalized)) return false;
  if (["1", "true", "on", "yes"].includes(normalized)) return true;
  return fallback;
}

/**
 * The protocol is explicit, never guessed from the model name: a Claude model
 * can also be served through an OpenAI-compatible gateway, and those two
 * paths need different request shapes.
 */
export function resolveProvider(value: string | undefined): ProviderKind {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized === "") return "openai";
  if (normalized === "openai" || normalized === "anthropic") {
    return normalized;
  }
  throw new Error(
    `Invalid COOPER_PROVIDER "${value}". Use "openai" or "anthropic".`,
  );
}

export function loadConfig(
  options: { env?: NodeJS.ProcessEnv; loadEnv?: boolean } = {},
): Config {
  if (options.loadEnv !== false) loadEnvFiles();
  const env = options.env ?? process.env;

  const provider = resolveProvider(env.COOPER_PROVIDER);
  const apiKey =
    provider === "anthropic"
      ? (env.COOPER_API_KEY ?? env.ANTHROPIC_API_KEY ?? "")
      : (env.COOPER_API_KEY ?? env.OPENAI_API_KEY ?? "");
  if (!apiKey.trim()) {
    throw new Error(
      provider === "anthropic"
        ? "No API key found. Set COOPER_API_KEY or ANTHROPIC_API_KEY."
        : "No API key found. Copy .env.example to .env and set COOPER_API_KEY (or OPENAI_API_KEY).",
    );
  }

  // Provider-specific endpoint wins over the generic override: a stale
  // COOPER_BASE_URL (for example the OpenAI example in .env) must not hijack
  // an Anthropic run.
  const baseURL =
    provider === "anthropic"
      ? (nonEmpty(env.ANTHROPIC_BASE_URL) ?? nonEmpty(env.COOPER_BASE_URL))
      : (nonEmpty(env.OPENAI_BASE_URL) ?? nonEmpty(env.COOPER_BASE_URL));
  const modelOverride = env.COOPER_MODEL?.trim();
  const model =
    modelOverride !== undefined && modelOverride !== ""
      ? modelOverride
      : provider === "anthropic"
        ? env.ANTHROPIC_MODEL?.trim() || DEFAULT_ANTHROPIC_MODEL
        : env.OPENAI_MODEL?.trim() || DEFAULT_OPENAI_MODEL;

  const windowOverride = env.COOPER_CONTEXT_WINDOW?.trim();
  const resolved =
    windowOverride !== undefined && windowOverride !== ""
      ? { window: positiveInt(windowOverride, DEFAULT_CONTEXT_WINDOW), assumed: false }
      : resolveContextWindow(model);

  const context: ContextSettings = {
    window: resolved.window,
    reserveOutputTokens: positiveInt(env.COOPER_CONTEXT_RESERVE, 16_384),
    summaryModel: env.COOPER_SUMMARY_MODEL?.trim() || undefined,
    enabled: envFlag(env.COOPER_CONTEXT_COMPACT, true),
  };

  return {
    provider,
    apiKey,
    baseURL,
    model,
    maxOutputTokens: positiveInt(
      env.COOPER_MAX_OUTPUT_TOKENS,
      DEFAULT_MAX_OUTPUT_TOKENS,
    ),
    context,
    contextWindowAssumed: resolved.assumed,
    showReasoning: envFlag(env.COOPER_SHOW_REASONING, false),
  };
}
