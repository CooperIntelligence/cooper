import fs from "node:fs";
import path from "node:path";
import { cooperHome } from "@cooper/core";
import { z } from "zod";

/**
 * Long-term preference files, one per scope:
 *
 *   user    <COOPER_HOME>/config.json   (default ~/.cooper/config.json)
 *   project <workspace>/.cooper/config.json
 *
 * Precedence between layers (and against env/flags) is resolved in
 * `loadConfig()`; this module only loads and validates each layer.
 *
 * Secrets never live here. The project layer additionally may not redirect
 * network or credential resolution (`provider`, `baseURL`, `apiKeyEnv`): a
 * cloned repository must not be able to point the user's API key at its own
 * server. Those fields in a project file are dropped with a warning.
 */

const contextSchema = z.object({
  window: z.number().int().positive().optional(),
  reserveOutputTokens: z.number().int().positive().optional(),
  compact: z.boolean().optional(),
  summaryModel: z.string().min(1).optional(),
});

const settingsSchema = z.object({
  provider: z.enum(["openai", "anthropic"]).optional(),
  model: z.string().min(1).optional(),
  baseURL: z.string().min(1).optional(),
  apiKeyEnv: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be an environment variable name")
    .optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  showReasoning: z.boolean().optional(),
  mode: z.enum(["plan", "ask", "auto"]).optional(),
  context: contextSchema.optional(),
});

export type Settings = z.infer<typeof settingsSchema>;

/** Fields the project layer may override; everything else is dropped there. */
const PROJECT_FIELDS = new Set([
  "model",
  "maxOutputTokens",
  "showReasoning",
  "mode",
  "context",
]);

/** Shape used to report unknown keys (values are nested key names). */
const KNOWN_SHAPE: Record<string, string[] | true> = {
  provider: true,
  model: true,
  baseURL: true,
  apiKeyEnv: true,
  maxOutputTokens: true,
  showReasoning: true,
  mode: true,
  context: ["window", "reserveOutputTokens", "compact", "summaryModel"],
};

// Whole-key matches only: substrings would eat legitimate names like
// `maxOutputTokens` or the `apiKeyEnv` pointer itself.
const SECRET_KEY =
  /^(api[-_]?key|key|token|secret|password|credential|credentials)$|[-_](token|secret|password|key)$|(apikey|token|secret|password)$/i;

export type LoadedSettings = {
  user: Settings | null;
  project: Settings | null;
  /** Absolute paths of the files that contributed a layer (for /status). */
  userFile: string | null;
  projectFile: string | null;
  warnings: string[];
};

export function userConfigFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(cooperHome(env), "config.json");
}

export function projectConfigFile(root: string): string {
  return path.join(root, ".cooper", "config.json");
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

type LayerResult = { settings: Settings; warnings: string[] };

function loadLayer(file: string, scope: "user" | "project"): LayerResult | null {
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

  for (const key of Object.keys(raw)) {
    if (SECRET_KEY.test(key)) {
      warnings.push(
        `${file}: "${key}" looks like a secret; configuration files must not ` +
          `hold credentials — put keys in .env (ignored).`,
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
  const settings = parsed.data;

  if (scope === "project") {
    for (const key of Object.keys(settings) as (keyof Settings)[]) {
      if (!PROJECT_FIELDS.has(key)) {
        warnings.push(
          `${file}: "${key}" is not allowed in a project config (ignored); ` +
            `set it in ${userConfigFile()} or the environment instead.`,
        );
        delete settings[key];
      }
    }
    if (settings.mode === "auto") {
      warnings.push(
        `${file}: mode "auto" is not allowed in a project config (ignored); ` +
          `pass --mode auto or set it in ${userConfigFile()}.`,
      );
      delete settings.mode;
    }
  }

  return { settings, warnings };
}

/**
 * Reads both settings layers. Missing files are normal (a fresh install has
 * neither); malformed files are hard errors so a typo never silently changes
 * behaviour.
 */
export function loadSettings(
  options: { root: string; env?: NodeJS.ProcessEnv } = {
    root: process.cwd(),
  },
): LoadedSettings {
  const env = options.env ?? process.env;
  const userFile = userConfigFile(env);
  const projectFile = projectConfigFile(options.root);

  const user = loadLayer(userFile, "user");
  const project = loadLayer(projectFile, "project");

  return {
    user: user?.settings ?? null,
    project: project?.settings ?? null,
    userFile: user !== null ? userFile : null,
    projectFile: project !== null ? projectFile : null,
    warnings: [...(user?.warnings ?? []), ...(project?.warnings ?? [])],
  };
}
