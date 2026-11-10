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
import { loadSettings, type LoadedSettings } from "./settings.js";

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

/** Which layer supplied an effective value; surfaced by `/status`. */
export type ConfigSource = "flag" | "env" | "project" | "user" | "default";

export type ConfigKey =
  | "provider"
  | "baseURL"
  | "model"
  | "apiKey"
  | "maxOutputTokens"
  | "showReasoning"
  | "context.window"
  | "context.reserveOutputTokens"
  | "context.compact"
  | "context.summaryModel";

export type Config = {
  provider: ProviderKind;
  apiKey: string;
  /** Which environment variable supplied the key (never the value itself). */
  apiKeyVariable: string;
  baseURL: string | undefined;
  model: string;
  /** Anthropic `max_tokens`; streaming keeps a high ceiling safe. */
  maxOutputTokens: number;
  context: ContextSettings;
  /** True when the model was not recognised and a default window was assumed. */
  contextWindowAssumed: boolean;
  /** Stream reasoning text instead of showing only an indicator. */
  showReasoning: boolean;
  /**
   * Approval mode from the settings files (project beats user; the project
   * layer can never carry `auto`). undefined when no file sets one — the
   * session/env/flag resolution in `resolveModeForSession` then decides.
   */
  defaultMode: ApprovalMode | undefined;
  /** Per-key provenance for `/status`. */
  sources: Partial<Record<ConfigKey, ConfigSource>>;
  /** Warnings from the settings files (unknown keys, dropped fields, …). */
  settingsWarnings: string[];
  /** Paths of the settings files that exist, for `/status`. */
  settingsFiles: { user: string | null; project: string | null };
};

export type ConfigOverrides = {
  /** `--model`; beats every file and env layer. */
  model?: string;
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

/** undefined when unset or unrecognised (unrecognised falls through). */
function envFlagValue(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized === "") return undefined;
  if (["0", "false", "off", "no"].includes(normalized)) return false;
  if (["1", "true", "on", "yes"].includes(normalized)) return true;
  return undefined;
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

const EMPTY_SETTINGS: LoadedSettings = {
  user: null,
  project: null,
  userFile: null,
  projectFile: null,
  warnings: [],
};

/**
 * Resolves the effective configuration for one run.
 *
 * Per-key precedence: overrides (flags) > env > project settings file >
 * user settings file > built-in defaults. The API key is the exception: it
 * only ever comes from the environment (`settings.user.apiKeyEnv` names
 * which variable to try first), never from a file.
 */
export function loadConfig(
  options: {
    env?: NodeJS.ProcessEnv;
    loadEnv?: boolean;
    /** Workspace root; enables the project/user settings files. */
    root?: string;
    overrides?: ConfigOverrides;
  } = {},
): Config {
  if (options.loadEnv !== false) loadEnvFiles();
  const env = options.env ?? process.env;
  const settings =
    options.root !== undefined
      ? loadSettings({ root: options.root, env })
      : EMPTY_SETTINGS;
  const { user, project } = settings;
  const sources: Partial<Record<ConfigKey, ConfigSource>> = {};

  // --- provider (env and user only; the project layer may not redirect) ---
  const providerEnv = nonEmpty(env.COOPER_PROVIDER);
  const provider =
    providerEnv !== undefined
      ? resolveProvider(providerEnv)
      : (user?.provider ?? "openai");
  sources.provider =
    providerEnv !== undefined ? "env" : user?.provider ? "user" : "default";

  // --- model ---
  const flagModel = nonEmpty(options.overrides?.model);
  const envModel = nonEmpty(env.COOPER_MODEL);
  const providerEnvModel = nonEmpty(
    provider === "anthropic" ? env.ANTHROPIC_MODEL : env.OPENAI_MODEL,
  );
  const model =
    flagModel ??
    envModel ??
    providerEnvModel ??
    project?.model ??
    user?.model ??
    (provider === "anthropic" ? DEFAULT_ANTHROPIC_MODEL : DEFAULT_OPENAI_MODEL);
  sources.model =
    flagModel !== undefined
      ? "flag"
      : envModel !== undefined || providerEnvModel !== undefined
        ? "env"
        : project?.model !== undefined
          ? "project"
          : user?.model !== undefined
            ? "user"
            : "default";

  // --- endpoint ---
  const envBase =
    (provider === "anthropic"
      ? nonEmpty(env.ANTHROPIC_BASE_URL)
      : nonEmpty(env.OPENAI_BASE_URL)) ?? nonEmpty(env.COOPER_BASE_URL);
  const baseURL = envBase ?? user?.baseURL;
  sources.baseURL =
    envBase !== undefined ? "env" : user?.baseURL !== undefined ? "user" : "default";

  // --- credentials: env only, pointer first, then the classic fallbacks ---
  const keyPointer = user?.apiKeyEnv;
  const pointerValue = keyPointer !== undefined ? nonEmpty(env[keyPointer]) : undefined;
  const providerKeyVar =
    provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
  const apiKeyVariable =
    pointerValue !== undefined
      ? (keyPointer as string)
      : nonEmpty(env.COOPER_API_KEY) !== undefined
        ? "COOPER_API_KEY"
        : providerKeyVar;
  const apiKey =
    pointerValue ??
    nonEmpty(env.COOPER_API_KEY) ??
    (provider === "anthropic"
      ? nonEmpty(env.ANTHROPIC_API_KEY)
      : nonEmpty(env.OPENAI_API_KEY)) ??
    "";
  if (!apiKey.trim()) {
    if (keyPointer !== undefined) {
      throw new Error(`No API key found. Set ${keyPointer}.`);
    }
    throw new Error(
      provider === "anthropic"
        ? "No API key found. Set COOPER_API_KEY or ANTHROPIC_API_KEY."
        : "No API key found. Copy .env.example to .env and set COOPER_API_KEY (or OPENAI_API_KEY).",
    );
  }
  sources.apiKey = "env";

  // --- max output tokens ---
  const envMax = nonEmpty(env.COOPER_MAX_OUTPUT_TOKENS);
  const maxOutputTokens =
    envMax !== undefined
      ? positiveInt(envMax, DEFAULT_MAX_OUTPUT_TOKENS)
      : (project?.maxOutputTokens ?? user?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS);
  sources.maxOutputTokens =
    envMax !== undefined ? "env" : project?.maxOutputTokens !== undefined ? "project" : user?.maxOutputTokens !== undefined ? "user" : "default";

  // --- context budget ---
  const envWindow = nonEmpty(env.COOPER_CONTEXT_WINDOW);
  const projectWindow = project?.context?.window;
  const userWindow = user?.context?.window;
  let window: number;
  let assumed: boolean;
  if (envWindow !== undefined) {
    window = positiveInt(envWindow, DEFAULT_CONTEXT_WINDOW);
    assumed = false;
  } else if (projectWindow !== undefined || userWindow !== undefined) {
    window = (projectWindow ?? userWindow) as number;
    assumed = false;
  } else {
    const resolved = resolveContextWindow(model);
    window = resolved.window;
    assumed = resolved.assumed;
  }
  sources["context.window"] =
    envWindow !== undefined ? "env" : projectWindow !== undefined ? "project" : userWindow !== undefined ? "user" : "default";

  const envReserve = nonEmpty(env.COOPER_CONTEXT_RESERVE);
  const reserveOutputTokens =
    envReserve !== undefined
      ? positiveInt(envReserve, 16_384)
      : (project?.context?.reserveOutputTokens ??
        user?.context?.reserveOutputTokens ??
        16_384);
  sources["context.reserveOutputTokens"] =
    envReserve !== undefined ? "env" : project?.context?.reserveOutputTokens !== undefined ? "project" : user?.context?.reserveOutputTokens !== undefined ? "user" : "default";

  const envCompact = envFlagValue(env.COOPER_CONTEXT_COMPACT);
  const compact =
    envCompact ?? project?.context?.compact ?? user?.context?.compact ?? true;
  sources["context.compact"] =
    envCompact !== undefined ? "env" : project?.context?.compact !== undefined ? "project" : user?.context?.compact !== undefined ? "user" : "default";

  const envSummary = nonEmpty(env.COOPER_SUMMARY_MODEL);
  const summaryModel =
    envSummary ?? project?.context?.summaryModel ?? user?.context?.summaryModel ?? undefined;
  sources["context.summaryModel"] =
    envSummary !== undefined ? "env" : project?.context?.summaryModel !== undefined ? "project" : user?.context?.summaryModel !== undefined ? "user" : "default";

  const context: ContextSettings = {
    window,
    reserveOutputTokens,
    summaryModel,
    enabled: compact,
  };

  // --- display ---
  const envShowReasoning = envFlagValue(env.COOPER_SHOW_REASONING);
  const showReasoning =
    envShowReasoning ?? project?.showReasoning ?? user?.showReasoning ?? false;
  sources.showReasoning =
    envShowReasoning !== undefined ? "env" : project?.showReasoning !== undefined ? "project" : user?.showReasoning !== undefined ? "user" : "default";

  return {
    provider,
    apiKey,
    apiKeyVariable,
    baseURL,
    model,
    maxOutputTokens,
    context,
    contextWindowAssumed: assumed,
    showReasoning,
    defaultMode: project?.mode ?? user?.mode,
    sources,
    settingsWarnings: settings.warnings,
    settingsFiles: { user: settings.userFile, project: settings.projectFile },
  };
}
