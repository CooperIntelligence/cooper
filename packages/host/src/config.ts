import {
  resolveCommandShell,
  resolveContextWindow,
  resolveContextConfig,
  contextInputLimit,
  modelTierNames,
  validateModelRequest,
  type CommandShell,
  type ContextSettings,
  type ModelSelection,
  type ModelTier,
  type PermissionPreset,
} from "@cooper/core";
import { loadSettings, userConfigFile, type LoadedSettings, type Settings } from "./settings.js";

export type ApprovalMode = PermissionPreset;
export type ProtocolKind = NonNullable<Settings["protocol"]>;

export const DEFAULT_MAX_OUTPUT_TOKENS = 64_000;
export type ConfigSource = "flag" | "config" | "default";

export type ConfigKey =
  | "protocol"
  | "baseURL"
  | "model"
  | "apiKey"
  | "maxOutputTokens"
  | "showReasoning"
  | "shell"
  | "context.window"
  | "context.reserveOutputTokens"
  | "context.compact"
  | "context.summaryModel";

const connectionFields = ["protocol", "model", "baseURL", "apiKey"] as const;
type ConnectionField = (typeof connectionFields)[number];
type ConnectionSettings = Pick<Settings, ConnectionField>;

export type WebSearchConfig = false | { apiKey?: string };

type ModelTierEntry = {
  selection: ModelSelection;
  displayName?: string;
  assumed: boolean;
  windowSource: ConfigSource;
  outputSource: ConfigSource;
};

export type Config = Required<ConnectionSettings> & {
  maxOutputTokens: number;
  context: ContextSettings;
  contextWindowAssumed: boolean;
  showReasoning: boolean;
  defaultMode: Settings["mode"];
  shell: CommandShell;
  linuxNetworkWorkspaces?: readonly string[];
  webSearch: WebSearchConfig;
  sources: Partial<Record<ConfigKey, ConfigSource>>;
  settingsWarnings: string[];
  settingsFile: string | null;
  modelTiers?: {
    fallback: ModelSelection;
    entries: Partial<Record<ModelTier, ModelTierEntry>>;
    defaultTier?: ModelTier;
    fallbackAssumed: boolean;
    fallbackWindowSource: ConfigSource;
    fallbackOutputSource: ConfigSource;
  };
  modelSelection?: ModelSelection;
  tierDisplayName?: string;
  tierFallback?: boolean;
};

const MIN_TIER_WINDOW = 256_000;

function validateWindow(selection: Pick<ModelSelection, "contextWindow" | "maxOutputTokens">, field: string): void {
  const { contextWindow, maxOutputTokens } = selection;
  if (contextWindow < MIN_TIER_WINDOW) {
    throw new Error(`${field} resolves to ${contextWindow} tokens. Model tiers require at least ${MIN_TIER_WINDOW} tokens. Set the window supported by your service.`);
  }
  if (maxOutputTokens !== undefined && maxOutputTokens >= contextWindow) {
    throw new Error(`${field}: maxOutputTokens (${maxOutputTokens}) must be less than the context window (${contextWindow}).`);
  }
}

/** Apply a user or session selection, or use the configured startup default. */
export function selectModelTier(config: Config, tier?: ModelTier | null): Config {
  const tiers = config.modelTiers;
  if (!tiers) return config;
  const configured = Object.keys(tiers.entries).length > 0 || tiers.defaultTier !== undefined;
  const selected = tier === undefined ? tiers.defaultTier ?? (configured ? "cher" : null) : tier;
  const experimental = configured || selected !== null;
  const entry = selected === null ? undefined : tiers.entries[selected];
  const base = entry?.selection ?? tiers.fallback;
  const context = {
    ...config.context,
    window: base.contextWindow,
    maxOutputTokens: experimental ? base.maxOutputTokens : undefined,
  };
  const selection = { ...base, tier: selected, inputLimit: contextInputLimit(resolveContextConfig(context)) };
  if (experimental) validateWindow(tiers.fallback, "Fallback model context.window");
  return {
    ...config,
    model: selection.model,
    maxOutputTokens: selection.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    context,
    contextWindowAssumed: entry?.assumed ?? tiers.fallbackAssumed,
    sources: {
      ...config.sources,
      "context.window": entry?.windowSource ?? tiers.fallbackWindowSource,
      maxOutputTokens: selection.maxOutputTokens === undefined
        ? "default" : entry?.outputSource ?? tiers.fallbackOutputSource,
    },
    modelSelection: selection,
    tierDisplayName: selected === null ? undefined : entry?.displayName ?? modelTierNames[selected],
    tierFallback: selected !== null && entry === undefined,
  };
}

export function describeModel(config: Config): string {
  const tier = config.modelSelection?.tier;
  if (!tier) return config.model;
  const name = modelTierNames[tier];
  const label = config.tierDisplayName && config.tierDisplayName !== name
    ? `${name} · ${config.tierDisplayName}` : name;
  return `${label} (${config.tierFallback ? "fallback: " : ""}${config.model})`;
}

export function modelSelectionChanged(saved: ModelSelection | undefined, config: Config): boolean {
  const next = config.modelSelection;
  return saved !== undefined && next !== undefined && (
    saved.model !== next.model || saved.reasoningEffort !== next.reasoningEffort ||
    saved.contextWindow !== next.contextWindow || saved.maxOutputTokens !== next.maxOutputTokens ||
    saved.inputLimit !== next.inputLimit
  );
}

export function modelRequestError(config: Config, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  if (!config.modelSelection?.tier) return detail;
  const { reasoningEffort, maxOutputTokens } = config.modelSelection;
  return `${describeModel(config)} · reasoningEffort=${reasoningEffort ?? "default"}, maxOutputTokens=${maxOutputTokens ?? "default"} · ${detail}`;
}

export class IncompleteConfigError extends Error {
  readonly missing: readonly ConnectionField[];

  constructor(
    readonly settings: ConnectionSettings & { contextWindow?: number },
    file: string,
    readonly warnings: readonly string[],
  ) {
    const missing = connectionFields.filter((field) => settings[field] === undefined);
    super(
      `Incomplete configuration (missing: ${missing.join(", ")}). ` +
        `Set them in ${file} or run cooper interactively to complete setup.`,
    );
    this.name = "IncompleteConfigError";
    this.missing = missing;
  }
}

/** Resolve Cooper settings from the user configuration file. */
type ConfigOptions = { home?: string; showReasoning?: boolean; windowsShell?: CommandShell };

export function loadConfig(options: ConfigOptions = {}): Config {
  return resolveConfig(loadSettings(options), options);
}

export function resolveConfig(
  { settings, file, warnings }: LoadedSettings,
  options: ConfigOptions = {},
): Config {
  const { protocol, model, baseURL, apiKey } = settings ?? {};
  if (protocol === undefined || model === undefined ||
      baseURL === undefined || apiKey === undefined) {
    throw new IncompleteConfigError(
      { protocol, model, baseURL, apiKey, contextWindow: settings?.context?.window },
      file ?? userConfigFile(options.home),
      warnings,
    );
  }
  if (!URL.canParse(baseURL) || !["http:", "https:"].includes(new URL(baseURL).protocol)) {
    throw new Error(`Invalid baseURL in ${file}. Use an absolute HTTP or HTTPS URL.`);
  }

  const context = settings?.context;
  const configuredWindow = context?.window;
  const { window, assumed } = configuredWindow === undefined
    ? resolveContextWindow(model)
    : { window: configuredWindow, assumed: false };
  const source = (value: unknown): ConfigSource =>
    value === undefined ? "default" : "config";
  const searchSettings = settings?.webSearch;
  const key = searchSettings ? process.env[searchSettings.apiKeyEnv]?.trim() : undefined;
  const webSearchApiKey = key && /^[\x21-\x7e]+$/.test(key) ? key : undefined;
  const webSearch: WebSearchConfig = searchSettings === undefined
    ? {}
    : webSearchApiKey ? { apiKey: webSearchApiKey } : false;
  const searchWarnings = searchSettings && !webSearchApiKey
    ? [...warnings, `Web search is disabled. Set a valid Tavily API key in ${searchSettings.apiKeyEnv}.`]
    : warnings;
  const settingsWarnings = options.windowsShell && settings?.shell
    ? [...searchWarnings, "Windows uses the bundled PowerShell 7; the configured shell is ignored."]
    : searchWarnings;

  const fallbackOutput = settings?.maxOutputTokens ?? (protocol === "anthropic-messages" ? DEFAULT_MAX_OUTPUT_TOKENS : undefined);
  const makeSelection = (
    tier: ModelTier | null, id: string, contextWindow: number,
    maxOutputTokens: number | undefined, reasoningEffort?: ModelSelection["reasoningEffort"],
  ): ModelSelection => ({
    tier, model: id, contextWindow, maxOutputTokens, reasoningEffort,
    inputLimit: contextInputLimit(resolveContextConfig({
      window: contextWindow, reserveOutputTokens: context?.reserveOutputTokens,
      maxOutputTokens,
    })),
  });
  const entries: NonNullable<Config["modelTiers"]>["entries"] = {};
  for (const tier of Object.keys(modelTierNames) as ModelTier[]) {
    const entry = settings?.modelTiers?.[tier];
    if (!entry) continue;
    const explicitWindow = entry.contextWindow ?? configuredWindow;
    const resolved = explicitWindow === undefined
      ? resolveContextWindow(entry.model) : { window: explicitWindow, assumed: false };
    const entrySelection = makeSelection(tier, entry.model, resolved.window,
      entry.maxOutputTokens ?? fallbackOutput, entry.reasoningEffort);
    const field = `modelTiers.${tier}`;
    validateWindow(entrySelection, `${field}.contextWindow`);
    validateModelRequest(protocol, baseURL, entry.model, entry.reasoningEffort, field);
    entries[tier] = {
      selection: entrySelection, displayName: entry.displayName, assumed: resolved.assumed,
      windowSource: source(explicitWindow), outputSource: source(entry.maxOutputTokens ?? settings?.maxOutputTokens),
    };
  }
  const fallback = makeSelection(null, model, window, fallbackOutput);
  return selectModelTier({
    protocol,
    model,
    baseURL,
    apiKey,
    maxOutputTokens: settings?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    context: {
      window,
      reserveOutputTokens: context?.reserveOutputTokens ?? 16_384,
      summaryModel: context?.summaryModel,
      enabled: context?.compact ?? true,
    },
    contextWindowAssumed: assumed,
    showReasoning: options.showReasoning || (settings?.showReasoning ?? false),
    defaultMode: settings?.mode,
    shell: options.windowsShell ?? resolveCommandShell(settings?.shell),
    linuxNetworkWorkspaces: settings?.linuxNetworkWorkspaces,
    webSearch,
    sources: {
      protocol: "config",
      model: "config",
      baseURL: "config",
      apiKey: "config",
      maxOutputTokens: source(settings?.maxOutputTokens),
      showReasoning: options.showReasoning ? "flag" : source(settings?.showReasoning),
      shell: source(options.windowsShell ? undefined : settings?.shell),
      "context.window": source(configuredWindow),
      "context.reserveOutputTokens": source(context?.reserveOutputTokens),
      "context.compact": source(context?.compact),
      "context.summaryModel": source(context?.summaryModel),
    },
    settingsWarnings,
    settingsFile: file,
    modelTiers: {
      fallback, entries, defaultTier: settings?.defaultTier, fallbackAssumed: assumed,
      fallbackWindowSource: source(configuredWindow),
      fallbackOutputSource: source(settings?.maxOutputTokens),
    },
  });
}
