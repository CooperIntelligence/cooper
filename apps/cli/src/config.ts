import fs from "node:fs";
import dotenv from "dotenv";
import {
  DEFAULT_CONTEXT_WINDOW,
  resolveContextWindow,
  type ContextSettings,
  type PermissionPreset,
} from "@cooper/core";
import { loadSettings, userConfigFile } from "./settings.js";

/** ask: prompt before writes/commands · auto: allow everything · plan: read-only */
export type ApprovalMode = PermissionPreset;

/** The wire protocol Cooper speaks; one provider at a time (v1). */
export type ProtocolKind = "openai-chat" | "anthropic-messages";

const DEFAULT_PROTOCOL: ProtocolKind = "openai-chat";
export const DEFAULT_MAX_OUTPUT_TOKENS = 64_000;

/** Which layer supplied an effective value; surfaced by `/status`. */
export type ConfigSource =
  | "flag"
  | "env"
  | "config-env"
  | "config"
  | "default";

export type ConfigKey =
  | "protocol"
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
  protocol: ProtocolKind;
  apiKey: string;
  /** Which name supplied the key (never the value itself). */
  apiKeyVariable: string;
  /** Always explicit after a successful load — no silent protocol default. */
  baseURL: string;
  model: string;
  /** Anthropic `max_tokens`; streaming keeps a high ceiling safe. */
  maxOutputTokens: number;
  context: ContextSettings;
  /** True when the model was not recognised and a default window was assumed. */
  contextWindowAssumed: boolean;
  /** Stream reasoning text instead of showing only an indicator. */
  showReasoning: boolean;
  /**
   * Approval mode from `config.json`; undefined when unset — the
   * session/env/flag resolution in `resolveModeForSession` then decides.
   */
  defaultMode: ApprovalMode | undefined;
  /** Per-key provenance for `/status`. */
  sources: Partial<Record<ConfigKey, ConfigSource>>;
  /** Warnings from the settings file (unknown keys, misplaced secrets, …). */
  settingsWarnings: string[];
  /** Path of the settings file that loaded, for `/status`. */
  settingsFile: string | null;
};

export type ConfigOverrides = {
  /** `--model`; beats every env and file layer. */
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
export function resolveProtocol(value: string | undefined): ProtocolKind {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized === "") return DEFAULT_PROTOCOL;
  if (normalized === "openai-chat" || normalized === "anthropic-messages") {
    return normalized;
  }
  throw new Error(
    `Invalid protocol "${value}". Use "openai-chat" or "anthropic-messages".`,
  );
}

/**
 * Loads an env file for one run (`--env-file`). Unlike dotenv's normal
 * behaviour the file **wins** over the ambient environment: it is an
 * explicit per-run override, not a defaults layer.
 */
export function applyEnvFile(
  file: string,
  target: NodeJS.ProcessEnv = process.env,
): void {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Env file not found: ${file}`);
    }
    throw error;
  }
  const parsed = dotenv.parse(text);
  for (const [name, value] of Object.entries(parsed)) {
    target[name] = value;
  }
}

/**
 * Thrown when any required endpoint-contract field is missing after
 * flag/env/config resolution: `protocol`, `model`, `baseURL`, `apiKey`.
 *
 * None of them have built-in defaults — guessing (e.g. `gpt-4o-mini` or
 * `api.openai.com` against a third-party gateway) fails only at request time.
 * The interactive surface catches this to launch onboarding; headless reports
 * every missing field and fails closed.
 */
export class IncompleteConfigError extends Error {
  /** Missing field names, stable order: protocol, model, baseURL, apiKey. */
  readonly missing: readonly string[];

  constructor(missing: readonly string[], file: string) {
    const list = missing.join(", ");
    super(
      `Incomplete configuration (missing: ${list}). ` +
        `Set them in ${file} or the environment, ` +
        `or run cooper interactively once to be guided through setup.`,
    );
    this.name = "IncompleteConfigError";
    this.missing = missing;
  }
}

/**
 * Resolves the effective configuration for one run.
 *
 * Precedence per key: overrides (flags) > environment > `config.json` top
 * level > built-in defaults. The environment itself is layered first: the
 * config file's `env` block fills gaps but never overrides ambient variables
 * (shell and `--env-file` both land there before this runs).
 */
export function loadConfig(
  options: {
    env?: NodeJS.ProcessEnv;
    /** Overrides the `cooperHome()` anchor; tests only. */
    home?: string;
    overrides?: ConfigOverrides;
  } = {},
): Config {
  const rawEnv = options.env ?? process.env;
  const settings = loadSettings({ home: options.home });
  const configEnv = settings.settings?.env ?? {};

  // Effective env: ambient wins, config.env fills the gaps.
  const env: NodeJS.ProcessEnv = { ...configEnv, ...rawEnv };
  // Mirror into the live process env so child processes (run_command) see
  // the configured values too — only when operating on the real environment.
  if (rawEnv === process.env) {
    for (const [name, value] of Object.entries(configEnv)) {
      if (process.env[name] === undefined) process.env[name] = value;
    }
  }

  /** Source of an env-class value: ambient env vs the config `env` block. */
  const envSource = (name: string): "env" | "config-env" =>
    nonEmpty(rawEnv[name]) !== undefined ? "env" : "config-env";

  const sources: Partial<Record<ConfigKey, ConfigSource>> = {};
  const file = settings.file ?? userConfigFile(options.home);
  /** Missing required fields, filled during resolution, thrown together. */
  const missing: string[] = [];

  // --- protocol (config/env only; no flag in v1; no default) ---
  const protocolEnv = nonEmpty(env.COOPER_PROTOCOL);
  const protocol =
    protocolEnv !== undefined
      ? resolveProtocol(protocolEnv)
      : settings.settings?.protocol;
  if (protocol === undefined) {
    missing.push("protocol");
  } else {
    sources.protocol =
      protocolEnv !== undefined ? envSource("COOPER_PROTOCOL") : "config";
  }

  // --- endpoint: explicit always; no silent protocol default ---
  const baseURL = nonEmpty(env.COOPER_BASE_URL);
  if (baseURL === undefined) {
    missing.push("baseURL");
  } else {
    sources.baseURL = envSource("COOPER_BASE_URL");
  }

  // --- credentials: env-class only, ambient first ---
  const apiKey = nonEmpty(env.COOPER_API_KEY);
  if (apiKey === undefined) {
    missing.push("apiKey");
  } else {
    sources.apiKey = envSource("COOPER_API_KEY");
  }
  const apiKeyVariable = "COOPER_API_KEY";

  // --- model: required, never guessed from protocol or vendor ---
  const flagModel = nonEmpty(options.overrides?.model);
  const envModel = nonEmpty(env.COOPER_MODEL);
  const configModel = nonEmpty(settings.settings?.model);
  const model = flagModel ?? envModel ?? configModel;
  if (model === undefined) {
    missing.push("model");
  } else {
    sources.model =
      flagModel !== undefined
        ? "flag"
        : envModel !== undefined
          ? envSource("COOPER_MODEL")
          : "config";
  }

  // Report every gap at once so a broken config is fixed in one pass.
  if (missing.length > 0) {
    throw new IncompleteConfigError(missing, file);
  }
  // Narrowed: all four resolved above.
  const resolvedProtocol = protocol as ProtocolKind;
  const resolvedBaseURL = baseURL as string;
  const resolvedApiKey = apiKey as string;
  const resolvedModel = model as string;

  // --- max output tokens ---
  const envMax = nonEmpty(env.COOPER_MAX_OUTPUT_TOKENS);
  const configMax = settings.settings?.maxOutputTokens;
  const maxOutputTokens =
    envMax !== undefined
      ? positiveInt(envMax, DEFAULT_MAX_OUTPUT_TOKENS)
      : (configMax ?? DEFAULT_MAX_OUTPUT_TOKENS);
  sources.maxOutputTokens =
    envMax !== undefined
      ? envSource("COOPER_MAX_OUTPUT_TOKENS")
      : configMax !== undefined
        ? "config"
        : "default";

  // --- context budget ---
  const envWindow = nonEmpty(env.COOPER_CONTEXT_WINDOW);
  const configWindow = settings.settings?.context?.window;
  let window: number;
  let assumed: boolean;
  if (envWindow !== undefined) {
    window = positiveInt(envWindow, DEFAULT_CONTEXT_WINDOW);
    assumed = false;
  } else if (configWindow !== undefined) {
    window = configWindow;
    assumed = false;
  } else {
    const resolved = resolveContextWindow(resolvedModel);
    window = resolved.window;
    assumed = resolved.assumed;
  }
  sources["context.window"] =
    envWindow !== undefined
      ? envSource("COOPER_CONTEXT_WINDOW")
      : configWindow !== undefined
        ? "config"
        : "default";

  const envReserve = nonEmpty(env.COOPER_CONTEXT_RESERVE);
  const configReserve = settings.settings?.context?.reserveOutputTokens;
  const reserveOutputTokens =
    envReserve !== undefined
      ? positiveInt(envReserve, 16_384)
      : (configReserve ?? 16_384);
  sources["context.reserveOutputTokens"] =
    envReserve !== undefined
      ? envSource("COOPER_CONTEXT_RESERVE")
      : configReserve !== undefined
        ? "config"
        : "default";

  const envCompact = envFlagValue(env.COOPER_CONTEXT_COMPACT);
  const configCompact = settings.settings?.context?.compact;
  const compact = envCompact ?? configCompact ?? true;
  sources["context.compact"] =
    envCompact !== undefined
      ? envSource("COOPER_CONTEXT_COMPACT")
      : configCompact !== undefined
        ? "config"
        : "default";

  const envSummary = nonEmpty(env.COOPER_SUMMARY_MODEL);
  const configSummary = settings.settings?.context?.summaryModel;
  const summaryModel = envSummary ?? configSummary ?? undefined;
  sources["context.summaryModel"] =
    envSummary !== undefined
      ? envSource("COOPER_SUMMARY_MODEL")
      : configSummary !== undefined
        ? "config"
        : "default";

  const context: ContextSettings = {
    window,
    reserveOutputTokens,
    summaryModel,
    enabled: compact,
  };

  // --- display ---
  const envShowReasoning = envFlagValue(env.COOPER_SHOW_REASONING);
  const configShowReasoning = settings.settings?.showReasoning;
  const showReasoning = envShowReasoning ?? configShowReasoning ?? false;
  sources.showReasoning =
    envShowReasoning !== undefined
      ? envSource("COOPER_SHOW_REASONING")
      : configShowReasoning !== undefined
        ? "config"
        : "default";

  return {
    protocol: resolvedProtocol,
    apiKey: resolvedApiKey,
    apiKeyVariable,
    baseURL: resolvedBaseURL,
    model: resolvedModel,
    maxOutputTokens,
    context,
    contextWindowAssumed: assumed,
    showReasoning,
    defaultMode: settings.settings?.mode,
    sources,
    settingsWarnings: settings.warnings,
    settingsFile: settings.file,
  };
}
