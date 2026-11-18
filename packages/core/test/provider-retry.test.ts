import { expect, it } from "vitest";
import { providerRetryDelay } from "../src/provider/retry.js";

it("uses the retry-after header within the remaining wait budget", () => {
  const limited = { status: 429, headers: new Headers({ "retry-after": "4" }) };
  expect(providerRetryDelay(limited, 2, 5000)).toBe(4000);
  expect(providerRetryDelay(limited, 2, 3999)).toBeUndefined();
});

it.each([
  { status: 401 },
  { status: 429, error: { code: "insufficient_quota" } },
  { status: 400, code: "context_length_exceeded" },
  { message: "OpenAI Responses stream ended before a terminal event." },
])("does not retry permanent or invalid protocol responses", (error) => {
  expect(providerRetryDelay(error, 1, 15_000)).toBeUndefined();
});

it("retries only recognized transport or service failures", () => {
  expect(providerRetryDelay({ code: "overloaded_error" }, 1, 15_000)).toBe(1000);
  expect(providerRetryDelay({ status: 503 }, 2, 15_000)).toBe(2000);
  expect(providerRetryDelay({ cause: { code: "ECONNRESET" } }, 1, 15_000)).toBe(1000);
});
