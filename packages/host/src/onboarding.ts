import { type ProtocolKind } from "./config.js";
import { readSettingsDocument, writeSettingsDocument } from "./settings.js";

export type OnboardingResult = {
  protocol: ProtocolKind;
  /** Required: part of the endpoint contract; never filled with a vendor default. */
  model: string;
  apiKey: string;
  /** Always a concrete URL — the wizard never leaves this empty. */
  baseURL: string;
  /** Explicit override supplied in the wizard. */
  contextWindow?: number;
};

/** Official endpoint shown as a placeholder; still must be confirmed and written. */
export function defaultEndpoint(protocol: ProtocolKind): string {
  return protocol === "anthropic-messages"
    ? "https://api.anthropic.com"
    : "https://api.openai.com/v1";
}

/** The models listing request used to check endpoint connectivity. */
export function probeRequest(
  protocol: ProtocolKind,
  baseURL: string,
  apiKey: string,
): { url: string; headers: Record<string, string> } {
  const trimmed = baseURL.trim();
  if (trimmed === "") {
    // No silent official-endpoint fallback: the wizard always sets baseURL
    // before probing, and loadConfig requires it too.
    throw new Error("probeRequest requires an explicit baseURL.");
  }
  if (protocol === "anthropic-messages") {
    const root = trimmed.replace(/\/+$/, "");
    return {
      url: `${root}/v1/models`,
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
    };
  }
  const base = trimmed.replace(/\/+$/, "");
  return {
    url: `${base}/models`,
    headers: { Authorization: `Bearer ${apiKey}` },
  };
}

export async function probeEndpoint(
  protocol: ProtocolKind,
  baseURL: string,
  apiKey: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { url, headers } = probeRequest(protocol, baseURL, apiKey);
  try {
    const response = await fetch(url, {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    await response.body?.cancel();
    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error && error.name === "TimeoutError"
      ? "Connection timed out." : "Could not reach the models endpoint." };
  }
}

/** Merges the wizard result into the existing config, preserving other keys. */
export function mergeOnboardingConfig(
  existing: unknown,
  result: OnboardingResult,
): Record<string, unknown> {
  const base: Record<string, unknown> =
    existing !== null && typeof existing === "object" && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};
  // baseURL is required: always write a concrete URL (placeholder-confirmed
  // official endpoints count — loadConfig never invents one).
  const trimmedBase = result.baseURL.trim();
  if (trimmedBase === "") {
    throw new Error("Onboarding result is missing baseURL.");
  }
  if (result.contextWindow !== undefined) {
    const context = base.context;
    const preferences = context !== null && typeof context === "object" && !Array.isArray(context)
      ? context
      : {};
    base.context = { ...preferences, window: result.contextWindow };
  }
  return {
    ...base,
    protocol: result.protocol,
    model: result.model,
    apiKey: result.apiKey,
    baseURL: trimmedBase,
  };
}

/**
 * Replaces config.json after the complete new file has been written and flushed.
 * On POSIX the credential file is created with mode 0600.
 */
export function writeOnboardingConfig(
  home: string | undefined,
  result: OnboardingResult,
): string {
  let document;
  try {
    document = readSettingsDocument(home);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Refusing to overwrite unreadable settings. ${detail}`);
  }
  return writeSettingsDocument(document, mergeOnboardingConfig(document.raw, result));
}
