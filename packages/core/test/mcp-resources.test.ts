import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import {
  createMcpResourceTools,
  createResourceProvider,
  formatResourceResult,
} from "../src/mcp/resources.js";

const context = { root: process.cwd() };

async function connectedPair(options: { resources?: boolean } = {}) {
  const server = new Server(
    { name: "resource-server", version: "1.0.0" },
    {
      capabilities:
        options.resources === false ? { tools: {} } : { resources: {} },
    },
  );

  if (options.resources !== false) {
    server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
      if (request.params?.cursor === "page-2") {
        return { resources: [{ uri: "mem://b", name: "B" }] };
      }
      return {
        resources: [{ uri: "mem://a", name: "A" }],
        nextCursor: "page-2",
      };
    });

    server.setRequestHandler(
      ListResourceTemplatesRequestSchema,
      async () => ({
        resourceTemplates: [
          { uriTemplate: "mem://{id}", name: "Memory item" },
        ],
      }),
    );

    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      if (request.params.uri === "mem://bin") {
        return {
          contents: [
            {
              uri: request.params.uri,
              blob: "YWJj",
              mimeType: "application/octet-stream",
            },
          ],
        };
      }
      return {
        contents: [
          {
            uri: request.params.uri,
            text: "resource body",
            mimeType: "text/plain",
          },
        ],
      };
    });
  }

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

function toolByName(tools: ReturnType<typeof createMcpResourceTools>, name: string) {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`Missing tool ${name}`);
  return tool;
}

describe("MCP resource tools", () => {
  it("registers three read-only tools only when a server is configured", async () => {
    expect(createMcpResourceTools({ servers: new Map() })).toEqual([]);

    const { client, server } = await connectedPair();
    try {
      const provider = createResourceProvider("memory", client);
      const tools = createMcpResourceTools({
        servers: new Map([["memory", provider]]),
      });

      expect(tools.map((tool) => tool.name)).toEqual([
        "mcp_list_resources",
        "mcp_list_resource_templates",
        "mcp_read_resource",
      ]);
      for (const tool of tools) {
        expect(tool.capabilities).toEqual(["read"]);
        expect(tool.description).toContain("Configured MCP servers: memory");
      }
      expect(
        toolByName(tools, "mcp_read_resource").summarize?.({
          server: "memory",
          uri: "mem://a",
        }),
      ).toBe("MCP resource · memory · mem://a");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("aggregates pages without a cursor and returns one page with one", async () => {
    const { client, server } = await connectedPair();
    try {
      const provider = createResourceProvider("memory", client);
      const tools = createMcpResourceTools({
        servers: new Map([["memory", provider]]),
      });
      const list = toolByName(tools, "mcp_list_resources");
      const templates = toolByName(tools, "mcp_list_resource_templates");

      const all = await list.execute({ server: "memory" }, context);
      expect(all.content).toContain("mem://a");
      expect(all.content).toContain("mem://b");
      expect(all.content).not.toContain("nextCursor");

      const one = await list.execute(
        { server: "memory", cursor: "page-2" },
        context,
      );
      expect(one.content).toContain("mem://b");
      expect(one.content).not.toContain("mem://a");

      const templateResult = await templates.execute(
        { server: "memory" },
        context,
      );
      expect(templateResult.content).toContain("mem://{id}");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("reads text and projects binary blobs without inlining base64", async () => {
    const { client, server } = await connectedPair();
    try {
      const provider = createResourceProvider("memory", client);
      const tools = createMcpResourceTools({
        servers: new Map([["memory", provider]]),
      });
      const read = toolByName(tools, "mcp_read_resource");

      const text = await read.execute(
        { server: "memory", uri: "mem://a" },
        context,
      );
      expect(text.content).toContain("MCP server: memory");
      expect(text.content).toContain("resource body");

      const blob = await read.execute(
        { server: "memory", uri: "mem://bin" },
        context,
      );
      expect(blob.content).toContain(
        "[binary resource: 4 base64 characters",
      );
      expect(blob.content).not.toContain("YWJj");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("rejects unknown servers and servers without resource support", async () => {
    const { client, server } = await connectedPair();
    const toolsOnly = await connectedPair({ resources: false });
    try {
      const provider = createResourceProvider("memory", client);
      const tools = createMcpResourceTools({
        servers: new Map([["memory", provider]]),
      });
      const list = toolByName(tools, "mcp_list_resources");

      await expect(
        list.execute({ server: "missing" }, context),
      ).rejects.toThrow(/Unknown MCP server "missing"/);

      const noResources = createResourceProvider(
        "tools-only",
        toolsOnly.client,
      );
      expect(noResources.supportsResources).toBe(false);
      expect(await noResources.list()).toEqual({ resources: [] });
      await expect(noResources.read("mem://a")).rejects.toThrow(
        /does not support resources/,
      );

      const noResourceTools = createMcpResourceTools({
        servers: new Map([["tools-only", noResources]]),
      });
      const empty = await toolByName(
        noResourceTools,
        "mcp_list_resources",
      ).execute({ server: "tools-only" }, context);
      expect(empty.content).toContain('"resources": []');
    } finally {
      await client.close();
      await server.close();
      await toolsOnly.client.close();
      await toolsOnly.server.close();
    }
  });

  it("truncates oversized output at the configured cap", () => {
    const result = formatResourceResult(
      "memory",
      { contents: [{ uri: "mem://a", text: "x".repeat(100) }] },
      40,
    );
    expect(result.content).toContain("[truncated at 40 characters]");
  });
});
