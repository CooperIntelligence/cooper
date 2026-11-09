import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { listMcpTools } from "../src/mcp/client.js";
import {
  formatMcpResult,
  mcpToolName,
} from "../src/mcp/tool.js";
import { toToolSpec } from "../src/tools/tool.js";

const echoSchema = {
  type: "object",
  properties: { text: { type: "string" } },
  required: ["text"],
};

async function connectedPair() {
  const server = new Server(
    { name: "test-server", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "echo",
        description: "Echo the text back.",
        inputSchema: echoSchema,
        // Read-only annotations must NOT bypass the approval gate.
        annotations: { readOnlyHint: true },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => ({
    content: [{ type: "text", text: `echo: ${String(request.params.arguments?.["text"] ?? "")}` }],
  }));

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client(
    { name: "cooper-test", version: "0.0.0" },
    { capabilities: {} },
  );
  await client.connect(clientTransport);

  return { client, server };
}

describe("mcpToolName", () => {
  it("namespaces and sanitizes tool names", () => {
    expect(mcpToolName("file.server", "read/file")).toBe(
      "mcp__file_server__read_file",
    );
  });

  it("keeps long names under the provider limit", () => {
    const name = mcpToolName("s".repeat(60), "t".repeat(60));
    expect(name.length).toBeLessThanOrEqual(64);
    expect(mcpToolName("s".repeat(60), "t".repeat(60))).toBe(name);
  });
});

describe("formatMcpResult", () => {
  it("joins text blocks and reports errors", () => {
    expect(
      formatMcpResult({
        content: [
          { type: "text", text: "one" },
          { type: "text", text: "two" },
        ],
      }),
    ).toEqual({ content: "one\ntwo", isError: false });

    expect(
      formatMcpResult({ content: [], isError: true }),
    ).toEqual({ content: "(no output)", isError: true });
  });

  it("turns images and resources into readable placeholders", () => {
    expect(
      formatMcpResult({
        content: [
          { type: "image", data: "abc", mimeType: "image/png" },
          {
            type: "resource",
            resource: { uri: "file:///a.txt", text: "resource text" },
          },
          {
            type: "resource",
            resource: { uri: "file:///b.bin", blob: "abc", mimeType: "application/octet-stream" },
          },
        ],
      }).content,
    ).toBe(
      [
        "[image: image/png, 3 base64 chars]",
        "resource text",
        "[resource: file:///b.bin (application/octet-stream)]",
      ].join("\n"),
    );
  });

  it("falls back to structured content and truncates oversized output", () => {
    expect(
      formatMcpResult({ content: [], structuredContent: { ok: true } })
        .content,
    ).toBe('{\n  "ok": true\n}');

    const truncated = formatMcpResult(
      { content: [{ type: "text", text: "abcdefgh" }] },
      5,
    );
    expect(truncated.content).toBe("abcde\n\n[truncated at 5 characters]");
  });
});

describe("MCP tool adapter", () => {
  it("lists tools from a real MCP server and forwards the raw schema", async () => {
    const { client, server } = await connectedPair();
    try {
      const { tools, warnings } = await listMcpTools("test", client);
      expect(warnings).toEqual([]);
      expect(tools).toHaveLength(1);

      const tool = tools[0];
      expect(tool?.name).toBe("mcp__test__echo");
      // readOnlyHint is ignored: every MCP tool is approval-gated.
      expect(tool?.capabilities).toEqual(["execute"]);
      expect(tool?.summarize?.({ text: "hi" })).toBe(
        'MCP test · echo {"text":"hi"}',
      );
      expect(toToolSpec(tool!).parameters).toEqual(echoSchema);

      const result = await tool!.execute(
        { text: "hi" },
        { root: process.cwd() },
      );
      expect(result).toEqual({ content: "echo: hi", isError: false });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
