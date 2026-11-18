const CONNECTION_CODES = new Set([
  "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "EPIPE", "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET",
]);
const TEMPORARY_PROVIDER_CODES = new Set([
  "rate_limit_exceeded", "rate_limit_error", "overloaded_error", "server_error", "internal_server_error",
]);

/** Returns a delay only for temporary failures. Headers from the SDK may be Fetch Headers or a plain object. */
export function providerRetryDelay(error: unknown, attempt: number, remainingMs: number): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const failure = error as { status?: number; code?: string; type?: string; name?: string; message?: string;
    cause?: { code?: string }; error?: { code?: string; type?: string; error?: { type?: string } };
    headers?: Headers | Record<string, string> };
  const codes = [failure.code, failure.type, failure.error?.code, failure.error?.type, failure.error?.error?.type];
  if (codes.some((code) => code === "insufficient_quota" || code === "billing_hard_limit_reached") ||
      /insufficient.quota|quota (exceeded|exhausted)|billing hard limit|credit balance/i.test(failure.message ?? "")) return undefined;
  const transient = failure.status !== undefined
    ? [408, 429, 500, 502, 503, 504, 529].includes(failure.status)
    : CONNECTION_CODES.has(failure.code ?? "") || CONNECTION_CODES.has(failure.cause?.code ?? "") ||
      codes.some((code) => code !== undefined && TEMPORARY_PROVIDER_CODES.has(code)) ||
      failure.name === "APIConnectionError" || failure.name === "APIConnectionTimeoutError";
  if (!transient) return undefined;
  const headers = failure.headers;
  const retryAfter = headers instanceof Headers ? headers.get("retry-after") : headers?.["retry-after"];
  let delay = 1000 * 2 ** (attempt - 1);
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const requested = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(requested) && requested > 0) delay = Math.max(delay, requested);
  }
  return delay <= remainingMs ? delay : undefined;
}
