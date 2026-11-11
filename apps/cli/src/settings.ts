import fs from "node:fs";
import path from "node:path";
import { cooperHome } from "@cooper/core";
import { z } from "zod";

/**
 * The single settings file: `<home>/config.json` (home is the `cooperHome()`
 * constant — nothing may relocate it).
 *
 * Shape follows Claude Code's settings.json idea: every setting lives here.
 * Environment-variable-class values sit in the `env` object and are merged
 * into the process environment at the lowest precedence; everything else is a
 * top-level key. There is deliberately no workspace-scoped config: the
 * workspace is untrusted input and Cooper keeps zero ambient state there.
 *
 * `env` may hold credentials (`COOPER_API_KEY`) — that is the designed home
 * for them, so the secret sniffer only flags secret-looking *top-level* keys.
 */

const contextSchema = z.object({
  window: z.number().int().positive().optional(),
  reserveOutputTokens: z.number().int().positive().optional(),
  compact: z.boolean().optional(),
  summaryModel: z.string().min(1).optional(),
});

const settingsSchema = z.object({
  /** Environment-variable-class settings, e.g. COOPER_API_KEY, COOPER_BASE_URL. */
  env: z.record(z.string(), z.string()).optional(),
  protocol: z.enum(["openai-chat", "anthropic-messages"]).optional(),
  model: z.string().min(1).optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  showReasoning: z.boolean().optional(),
  mode: z.enum(["plan", "ask", "auto"]).optional(),
  context: contextSchema.optional(),
});

export type Settings = z.infer<typeof settingsSchema>;

/** Shape used to report unknown keys (values are nested key names). */
const KNOWN_SHAPE: Record<string, string[] | true> = {
  env: true, // arbitrary variable names, never flagged
  protocol: true,
  model: true,
  maxOutputTokens: true,
  showReasoning: true,
  mode: true,
  context: ["window", "reserveOutputTokens", "compact", "summaryModel"],
};

// Whole-key matches only: substrings would eat legitimate names like
// `maxOutputTokens`. Applied to top-level keys only — inside `env`, secrets
// are exactly what belongs there.
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

  // Secrets belong in the `env` object; a stray top-level secret is a
  // category mistake worth calling out (and never echoed back).
  for (const key of Object.keys(raw)) {
    if (key !== "env" && SECRET_KEY.test(key)) {
      warnings.push(
        `${file}: "${key}" looks like a secret; put credentials in the ` +
          `"env" object (e.g. "env": { "COOPER_API_KEY": "…" }) instead (ignored).`,
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
