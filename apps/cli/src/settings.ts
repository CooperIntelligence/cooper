import fs from "node:fs";
import path from "node:path";
import { cooperHome } from "@cooper/core";
import { z } from "zod";

/** The user configuration file is the source of provider settings. */

const contextSchema = z.object({
  window: z.number().int().positive().optional(),
  reserveOutputTokens: z.number().int().positive().optional(),
  compact: z.boolean().optional(),
  summaryModel: z.string().min(1).optional(),
});

const settingsSchema = z.object({
  protocol: z.enum(["openai-chat", "anthropic-messages"]).optional(),
  model: z.string().trim().min(1).optional(),
  baseURL: z.string().trim().min(1).optional(),
  apiKey: z.string().trim().min(1).optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  showReasoning: z.boolean().optional(),
  mode: z.enum(["plan", "ask"]).optional(),
  context: contextSchema.optional(),
});

export type Settings = z.infer<typeof settingsSchema>;

/** Shape used to report unknown keys (values are nested key names). */
const KNOWN_SHAPE: Record<string, string[] | true> = {
  protocol: true,
  model: true,
  baseURL: true,
  apiKey: true,
  maxOutputTokens: true,
  showReasoning: true,
  mode: true,
  context: ["window", "reserveOutputTokens", "compact", "summaryModel"],
};

// Whole-key matches only: substrings would eat legitimate names like
// `maxOutputTokens`.
const SECRET_KEY =
  /^(api[-_]?key|key|token|secret|password|credential|credentials)$|[-_](token|secret|password|key)$|(apikey|token|secret|password)$/i;

export type LoadedSettings = {
  settings: Settings | null;
  /** Absolute path of the file that loaded, for `/status`. */
  file: string | null;
  warnings: string[];
};

/** `config.json` under `home`; tests pass their own directory. */
export function userConfigFile(home: string = cooperHome()): string {
  return path.join(home, "config.json");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Collect unknown key paths so typos warn instead of silently doing nothing. */
function collectUnknownKeys(
  raw: Record<string, unknown>,
  shape: Record<string, string[] | true>,
  prefix = "",
): string[] {
  const unknown: string[] = [];
  for (const key of Object.keys(raw)) {
    const entry = shape[key];
    const full = prefix === "" ? key : `${prefix}.${key}`;
    if (entry === undefined) {
      unknown.push(full);
    } else if (entry !== true && isPlainObject(raw[key])) {
      const nested: Record<string, string[]> = {};
      for (const name of entry) nested[name] = [];
      unknown.push(...collectUnknownKeys(raw[key], nested, full));
    }
  }
  return unknown;
}

function formatIssues(file: string, error: z.ZodError): string {
  const detail = error.issues
    .map((issue) => {
      const where = issue.path.join(".");
      return where === "" ? issue.message : `${where}: ${issue.message}`;
    })
    .join("; ");
  return `Invalid settings in ${file}: ${detail}`;
}

function loadLayer(file: string): { settings: Settings; warnings: string[] } | null {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }

  let raw: unknown;
  try {
    // Strip a BOM so a Windows-saved file still parses.
    raw = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in ${file}: ${detail}`);
  }
  if (!isPlainObject(raw)) {
    throw new Error(`Invalid settings in ${file}: expected a JSON object.`);
  }

  const warnings: string[] = [];

  if (Object.hasOwn(raw, "env")) {
    warnings.push(
      `${file}: "env" is no longer supported (ignored). Move COOPER_BASE_URL and ` +
        "COOPER_API_KEY to the top-level baseURL and apiKey fields.",
    );
    delete raw.env;
  }

  if (raw.mode === "auto") {
    warnings.push(
      `${file}: mode "auto" is no longer a valid default (ignored). ` +
        "Use --mode auto or /auto in the TUI.",
    );
    delete raw.mode;
  }

  for (const key of Object.keys(raw)) {
    if (key !== "apiKey" && SECRET_KEY.test(key)) {
      warnings.push(
        `${file}: "${key}" looks like a secret (ignored). Use "apiKey" for the provider key.`,
      );
      delete raw[key];
    }
  }

  // Unknown keys only warn: the schema strips them (and any unknown nested
  // keys) on parse, so a typo never changes behaviour but is still visible.
  for (const key of collectUnknownKeys(raw, KNOWN_SHAPE)) {
    warnings.push(`${file}: unknown setting "${key}" (ignored).`);
  }

  const parsed = settingsSchema.safeParse(raw);
  if (!parsed.success) throw new Error(formatIssues(file, parsed.error));
  return { settings: parsed.data, warnings };
}

/**
 * Reads `config.json`. A missing file is normal (a fresh install has none);
 * malformed files are hard errors so a typo never silently changes behaviour.
 */
export function loadSettings(
  options: { home?: string } = {},
): LoadedSettings {
  const file = userConfigFile(options.home);
  const layer = loadLayer(file);
  return {
    settings: layer?.settings ?? null,
    file: layer !== null ? file : null,
    warnings: layer?.warnings ?? [],
  };
}
