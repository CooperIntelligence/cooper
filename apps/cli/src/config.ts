import path from "node:path";
import dotenv from "dotenv";

let envLoaded = false;

export function loadEnvFiles(): void {
  if (envLoaded) return;
  envLoaded = true;

  // Works both when the CLI runs from apps/cli (npm workspace) and from the
  // repository root (tsx apps/cli/src/index.tsx).
  const candidates = [
    path.resolve(process.cwd(), ".env"),
    path.resolve(process.cwd(), "../../.env"),
  ];
  for (const file of candidates) {
    dotenv.config({ path: file, quiet: true });
  }
}

/** ask: prompt before writes/commands · auto: allow everything · plan: read-only */
export type ApprovalMode = "ask" | "auto" | "plan";

export type Config = {
  apiKey: string;
  baseURL: string | undefined;
  model: string;
};

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

  return { apiKey, baseURL, model };
}
