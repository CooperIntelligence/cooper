import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import {
  createWebFetchTool, createWebSearchTool, PermissionPolicy, runAgent,
  type ApprovalOutcome, type Message, type Provider,
} from "../src/index.js";
import { createWebRequest, MAX_WEB_BYTES, type WebRequest } from "../src/tools/web-http.js";

const context = { root: process.cwd() };
type Transport = NonNullable<Parameters<typeof createWebRequest>[1]>;

function response(body: string | Buffer, headers = {}, statusCode = 200): IncomingMessage {
  return Object.assign(Readable.from([Buffer.from(body)]), { headers, statusCode }) as unknown as IncomingMessage;
}

describe("web_fetch", () => {
  it("renders public documentation with links, tables, and code", async () => {
    const tool = createWebFetchTool(async () => response(`
      <title>Release &amp; API</title><nav>menu</nav><main>
      <h1>Examples</h1><script>bad()</script>
      <a href="/api#options">Options</a>
      <table><tr><th>Flag</th><th>Default</th></tr><tr><td>verbose</td><td>false</td></tr></table>
      <pre><code>if (debug) {
  log();
}</code></pre></main>
    `, { "content-type": "text/html" }));
    const result = JSON.parse((await tool.execute({ url: "https://example.com/docs" }, context)).content);
    expect(result).toMatchObject({
      status: "ok", httpStatus: 200, contentType: "text/html",
      title: "Release & API", url: "https://example.com/docs", truncated: false,
    });
    expect(result.content).toContain("[Options](<https://example.com/api#options>)");
    expect(result.content).toContain("| Flag | Default |\n| --- | --- |\n| verbose | false |");
    expect(result.content).toContain("if (debug) {\n  log();\n}");
    expect(result.content).not.toMatch(/menu|bad\(\)/);
  });

  it("follows same-origin redirects and returns cross-origin destinations without requesting them", async () => {
    const request = vi.fn<WebRequest>()
      .mockImplementationOnce(async () => response("", { location: "/latest" }, 302))
      .mockImplementationOnce(async () => response("", { location: "http://127.0.0.1/test" }, 302));
    const tool = createWebFetchTool(request);
    const result = await tool.execute({ url: "https://example.com/docs" }, context);
    expect(request.mock.calls.map(([url]) => url.href)).toEqual(["https://example.com/docs", "https://example.com/latest"]);
    expect(JSON.parse(result.content)).toMatchObject({
      status: "redirect",
      httpStatus: 302,
      url: "https://example.com/latest",
      redirectUrl: "http://127.0.0.1/test",
    });
  });

  it("limits redirect loops and rejects unsupported content", async () => {
    const redirect = vi.fn<WebRequest>(async () => response("", { location: "/next" }, 302));
    const input = { url: "https://example.com" };
    const loop = await createWebFetchTool(redirect).execute(input, context);
    expect(loop.isError).toBe(true);
    expect(JSON.parse(loop.content)).toMatchObject({ status: "error", code: "redirect_limit", httpStatus: 302 });
    expect(redirect).toHaveBeenCalledTimes(4);
    const pdf = createWebFetchTool(async () => response("PDF", { "content-type": "application/pdf" }));
    const unsupported = await pdf.execute(input, context);
    expect(unsupported.isError).toBe(true);
    expect(JSON.parse(unsupported.content)).toMatchObject({
      status: "error", code: "unsupported_content_type", httpStatus: 200, contentType: "application/pdf",
    });
  });

  it("decodes compressed responses, caps output, and rejects oversized decompressed bodies", async () => {
    const headers = { "content-type": "text/plain", "content-encoding": "gzip" };
    const makeTool = (size: number) =>
      createWebFetchTool(async () => response(gzipSync("x".repeat(size)), headers));
    const input = { url: "https://example.com" };
    const result = JSON.parse((await makeTool(16_001).execute(input, context)).content);
    expect(result.content).toHaveLength(16_000);
    expect(result.truncated).toBe(true);
    const oversized = await makeTool(MAX_WEB_BYTES + 1).execute(input, context);
    expect(oversized.isError).toBe(true);
    expect(JSON.parse(oversized.content)).toMatchObject({ status: "error", code: "body_too_large", httpStatus: 200 });
  });

  it("preserves the title and HTTP metadata for an app shell after a redirect", async () => {
    const request = vi.fn<WebRequest>()
      .mockImplementationOnce(async () => response("", { location: "/chat-demo" }, 301))
      .mockImplementationOnce(async () => response(
        '<title>API 使用 demo</title><script defer src="/demo.js"></script><div id="root"></div>',
        { "content-type": "text/html; charset=utf-8" },
      ));
    const fetched = await createWebFetchTool(request).execute({ url: "https://example.com/demo" }, context);
    expect(fetched.isError).toBeUndefined();
    expect(JSON.parse(fetched.content)).toMatchObject({
      status: "no_static_text", httpStatus: 200, contentType: "text/html",
      url: "https://example.com/chat-demo", title: "API 使用 demo",
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([
    { body: "", type: undefined, http: 204, expected: "empty_body" },
    { body: "", type: undefined, http: 200, expected: "empty_body" },
    { body: " \n", type: "text/plain", http: 200, expected: "empty_text" },
    { body: "denied", type: "text/html", http: 403, expected: "error" },
  ])("reports $expected for HTTP $http with Content-Type $type", async ({ body, type, http, expected }) => {
    const tool = createWebFetchTool(async () => response(body, type ? { "content-type": type } : {}, http));
    const fetched = await tool.execute({ url: "https://example.com/" }, context);
    expect(JSON.parse(fetched.content)).toMatchObject({ status: expected, httpStatus: http, contentType: type ?? null });
    expect(Boolean(fetched.isError)).toBe(expected === "error");
  });

  it("reads body text when the main landmark is empty", async () => {
    const tool = createWebFetchTool(async () => response("<main></main><article>Real text</article>", { "content-type": "text/html" }));
    const fetched = await tool.execute({ url: "https://example.com/" }, context);
    expect(JSON.parse(fetched.content)).toMatchObject({ status: "ok", content: "Real text" });
  });

  it("distinguishes a failed request from an interrupted response body", async () => {
    const url = "https://example.com/";
    const failed = await createWebFetchTool(async () => {
      throw Object.assign(new Error("test DNS failure"), { code: "ENOTFOUND" });
    }).execute({ url }, context);
    expect(failed.isError).toBe(true);
    expect(JSON.parse(failed.content)).toMatchObject({
      status: "error", code: "request_failed", url, message: expect.stringContaining("ENOTFOUND"),
    });
    expect(JSON.parse(failed.content)).not.toHaveProperty("httpStatus");

    const broken = Object.assign(Readable.from((async function* () {
      yield Buffer.from("partial");
      throw new Error("test connection reset");
    })()), { headers: { "content-type": "text/plain" }, statusCode: 200 }) as unknown as IncomingMessage;
    const read = await createWebFetchTool(async () => broken).execute({ url }, context);
    expect(read.isError).toBe(true);
    expect(JSON.parse(read.content)).toMatchObject({ status: "error", code: "body_read_failed", httpStatus: 200 });
  });
});

describe("public web connections", () => {
  it.each(["http://127.1", "http://169.254.169.254", "http://[::ffff:10.0.0.1]", "http://[fd00::1]", "http://localhost."])(
    "blocks special-use destination %s before opening a socket",
    async (url) => {
      const transport = vi.fn<Transport>();
      const resolve = vi.fn();
      const blocked = await createWebFetchTool(createWebRequest(resolve, transport)).execute({ url }, context);
      expect(blocked.isError).toBe(true);
      expect(JSON.parse(blocked.content)).toMatchObject({ status: "error", code: "blocked_address" });
      expect(resolve).not.toHaveBeenCalled();
      expect(transport).not.toHaveBeenCalled();
    },
  );

  it("pins a single lookup to the connection and rejects mixed private DNS answers", async () => {
    const address = { address: "8.8.8.8", family: 4 };
    const resolve = vi.fn().mockResolvedValueOnce([address]).mockResolvedValueOnce([address, { address: "10.1.0.3", family: 4 }]);
    const transport = vi.fn<Transport>((options, onResponse) => {
      const connected = vi.fn();
      options.lookup!("example.com", { all: true }, connected);
      expect(connected).toHaveBeenCalledWith(null, [address]);
      expect(options.hostname).toBe("example.com");
      return {
        on() {},
        end() { onResponse(response("content", { "content-type": "text/plain" })); },
      };
    });
    const tool = createWebFetchTool(createWebRequest(resolve, transport));
    const input = { url: "http://example.com" };
    await expect(tool.execute(input, context)).resolves.toHaveProperty("content");
    expect(resolve).toHaveBeenCalledTimes(1);
    const blocked = await tool.execute(input, context);
    expect(JSON.parse(blocked.content)).toMatchObject({ status: "error", code: "blocked_address" });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("aborts during DNS lookup without opening a connection", async () => {
    const controller = new AbortController();
    const transport = vi.fn<Transport>();
    const resolve = vi.fn(() => new Promise<never>(() => {}));
    const tool = createWebFetchTool(createWebRequest(resolve, transport));
    const result = tool.execute({ url: "http://example.com" }, { ...context, signal: controller.signal });
    controller.abort();
    await expect(result).rejects.toHaveProperty("name", "AbortError");
    expect(transport).not.toHaveBeenCalled();
  });
});

describe("web_search", () => {
  it("sends credentials only to Tavily and bounds results without echoing credentials", async () => {
    const key = "tvly-test-credential";
    const request = vi.fn<WebRequest>(async () => response(JSON.stringify({ results: [
      { title: "Unsafe", url: "file:///tmp/test", content: "" },
      { title: "Docs", url: "https://example.com/", content: `Results ${key}` },
      { title: "Other", url: "https://example.org/", content: "Other result" },
    ] })));
    const tool = createWebSearchTool(key, request);
    const input = tool.inputSchema.parse({ query: "Node.js release notes", limit: 1 });
    expect(JSON.stringify(await tool.preview?.(input, context))).not.toContain(key);
    expect(request).not.toHaveBeenCalled();
    const result = await tool.execute(input, context);
    expect(result.content).not.toContain(key);
    expect(JSON.parse(result.content)).toEqual({
      results: [{ title: "Docs", url: "https://example.com/", snippet: "Results [redacted]" }],
    });
    const [url, options] = request.mock.calls[0]!;
    expect(url.href).toBe("https://api.tavily.com/search");
    expect(options.headers?.authorization).toBe(`Bearer ${key}`);
    expect(JSON.parse(options.body!)).toMatchObject({ query: input.query, max_results: 1, include_raw_content: false });
    expect(options.body).not.toContain(key);
  });

  it.each([[302, "HTTP 302"], [401, "credentials"], [429, "rate-limited"]] as const)(
    "handles HTTP %s without retrying or following redirects",
    async (status, error) => {
      const request = vi.fn<WebRequest>(async () => response("", { location: "https://example.com" }, status));
      const tool = createWebSearchTool("tvly-test", request);
      await expect(tool.execute(tool.inputSchema.parse({ query: "docs" }), context)).rejects.toThrow(error);
      expect(request).toHaveBeenCalledTimes(1);
    },
  );
});

describe("network tool approval", () => {
  it.each([
    { preset: "plan", interactive: true, outcome: "allow", prompts: 0, executions: 0 },
    { preset: "ask", interactive: false, outcome: "allow", prompts: 0, executions: 0 },
    { preset: "ask", interactive: true, outcome: "deny", prompts: 2, executions: 0 },
    { preset: "ask", interactive: true, outcome: "allow-session", prompts: 2, executions: 0 },
    { preset: "ask", interactive: true, outcome: "allow", prompts: 2, executions: 2 },
    { preset: "auto", interactive: false, outcome: "deny", prompts: 0, executions: 2 },
  ] as const)("enforces $preset/$interactive/$outcome in the agent loop", async ({ preset, interactive, outcome, prompts, executions }) => {
    const permissions = new PermissionPolicy({ preset, interactive });
    permissions.grantSession("web_fetch");
    const request = vi.fn<WebRequest>(async () => response("docs", { "content-type": "text/plain" }));
    const approve = vi.fn((): ApprovalOutcome => outcome);
    const messages: Message[] = [{ role: "user", content: "Read two pages" }];
    const provider: Provider = {
      async *stream({ messages }) {
        const calls = messages.some((message) => message.role === "tool") ? [] :
          ["https://example.com/a", "https://example.org/b"].map((url, id) => ({
            id: String(id), name: "web_fetch", arguments: JSON.stringify({ url }),
          }));
        yield { type: "done", message: { content: "", toolCalls: calls }, finishReason: calls.length ? "tool_calls" : "stop" };
      },
    };
    for await (const _event of runAgent({
      provider, permissions, approve, model: "test", context, messages, tools: [createWebFetchTool(request)],
    })) {
      // Drain the turn.
    }
    expect(approve).toHaveBeenCalledTimes(prompts);
    expect(request).toHaveBeenCalledTimes(executions);
    expect(messages.filter((message) => message.role === "tool")).toHaveLength(2);
  });
});
