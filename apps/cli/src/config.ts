import {
  resolveCommandShell,
  resolveContextWindow,
  type CommandShell,
  type ContextSettings,
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

export type Config = Required<ConnectionSettings> & {
  maxOutputTokens: number;
  context: ContextSettings;
  contextWindowAssumed: boolean;
  showReasoning: boolean;
  defaultMode: Settings["mode"];
  shell: CommandShell;
  webSearchApiKey?: string;
  sources: Partial<Record<ConfigKey, ConfigSource>>;
  settingsWarnings: string[];
  settingsFile: string | null;
};

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
export function loadConfig(options: { home?: string; showReasoning?: boolean } = {}): Config {
  return resolveConfig(loadSettings(options), options);
}

export function resolveConfig(
  { settings, file, warnings }: LoadedSettings,
  options: { home?: string; showReasoning?: boolean } = {},
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
  const webSearch = settings?.webSearch;
  const key = webSearch ? process.env[webSearch.apiKeyEnv]?.trim() : undefined;
  const webSearchApiKey = key && /^[\x21-\x7e]+$/.test(key) ? key : undefined;
  const settingsWarnings = webSearch && !webSearchApiKey
    ? [...warnings, `Web search is disabled. Set a valid Tavily API key in ${webSearch.apiKeyEnv}.`]
    : warnings;

  return {
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
    shell: resolveCommandShell(settings?.shell),
    webSearchApiKey,
    sources: {
      protocol: "config",
      model: "config",
      baseURL: "config",
      apiKey: "config",
      maxOutputTokens: source(settings?.maxOutputTokens),
      showReasoning: options.showReasoning ? "flag" : source(settings?.showReasoning),
      shell: source(settings?.shell),
      "context.window": source(configuredWindow),
      "context.reserveOutputTokens": source(context?.reserveOutputTokens),
      "context.compact": source(context?.compact),
      "context.summaryModel": source(context?.summaryModel),
    },
    settingsWarnings,
    settingsFile: file,
  };
}
