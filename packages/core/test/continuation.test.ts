import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  extendHistoryHash,
  hashAssistantFields,
  historySeed,
  invalidatePrefixContinuations,
  isContinuation,
  type Continuation,
} from "../src/provider/continuation.js";
import type { Message } from "../src/types.js";

function continuation(scope: Continuation["scope"]): Continuation {
  return {
    protocol: "anthropic-messages",
    endpoint: "endpoint",
    model: "model",
    scope,
    messageAnchor: "message",
    ...(scope === "message" ? {} : { historyAnchor: "history" }),
    payload: { content: [] },
  };
}

describe("canonicalJson", () => {
  it("sorts object keys recursively and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: undefined, c: 2 } })).toBe(
      '{"a":{"c":2},"b":1}',
    );
  });

  it("is stable across key insertion order", () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });
});

describe("assistant anchors", () => {
  it("changes when visible content or tool arguments change", () => {
    const base = hashAssistantFields("answer", []);
    expect(hashAssistantFields("answer ", [])).not.toBe(base);
    expect(
      hashAssistantFields("answer", [
        { id: "a", name: "echo", arguments: '{"text":"hi"}' },
      ]),
    ).not.toBe(base);
  });
});

describe("history anchors", () => {
  it("stays stable for identical wire messages and changes on edits", () => {
    const seed = historySeed("system", [{ name: "echo" }]);
    const user = { role: "user", content: "go" };
    const once = extendHistoryHash(seed, user);
    expect(extendHistoryHash(seed, { role: "user", content: "go" })).toBe(once);
    expect(extendHistoryHash(seed, { role: "user", content: "go " })).not.toBe(
      once,
    );
    expect(historySeed("system", [{ name: "echo " }])).not.toBe(seed);
  });
});

describe("isContinuation", () => {
  it("rejects malformed payloads and unknown protocols", () => {
    expect(isContinuation(continuation("prefix"))).toBe(true);
    expect(isContinuation({ ...continuation("prefix"), protocol: "other" })).toBe(
      false,
    );
    expect(isContinuation({ ...continuation("prefix"), scope: "other" })).toBe(
      false,
    );
    expect(isContinuation({ ...continuation("prefix"), payload: undefined })).toBe(
      true,
    );
    expect(isContinuation(null)).toBe(false);
  });
});

describe("invalidatePrefixContinuations", () => {
  it("marks prefix/response payloads stale but keeps their visible blocks", () => {
    const messages: Message[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "one",
        continuation: continuation("message"),
      },
      {
        role: "assistant",
        content: "two",
        continuation: continuation("prefix"),
      },
      {
        role: "assistant",
        content: "three",
        continuation: continuation("response"),
        providerData: { anthropic: { thinking: [] } },
      },
    ];

    invalidatePrefixContinuations(messages);

    expect(messages[1]).toMatchObject({ continuation: { scope: "message" } });
    expect(messages[1]).not.toMatchObject({ continuation: { stale: true } });
    expect(messages[2]).toMatchObject({
      continuation: { scope: "prefix", stale: true },
    });
    expect(messages[2]?.role === "assistant" ? messages[2].continuation?.payload : null).toEqual({
      content: [],
    });
    expect(messages[3]).toMatchObject({
      continuation: { scope: "response", stale: true },
    });
    expect(messages[3]).not.toHaveProperty("providerData");
  });
});
