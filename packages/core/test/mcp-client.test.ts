import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { connectMcpServers } from "../src/mcp/client.js";
import { createMcpResourceTools } from "../src/mcp/resources.js";

const fixture = fileURLToPath(
  new URL("./fixtures/mcp-stdio-server.mjs", import.meta.url),
);

function stdioServer() {
  return {
    type: "stdio" as const,
    // Run the fixture with the same Node binary running the tests.
    command: process.execPath,
    args: [fixture],
  };
}

describe("connectMcpServers", () => {
  it("connects a stdio server and closes idempotently", async () => {
    const connection = await connectMcpServers({
      servers: { fixture: stdioServer() },
      connectTimeoutMs: 10_000,
    });

    try {
      expect(connection.statuses).toEqual([
        { name: "fixture", ok: true, toolCount: 1 },
      ]);
      expect(connection.tools.map((tool) => tool.name)).toEqual([
        "mcp__fixture__echo",
      ]);

      const result = await connection.tools[0]!.execute(
        { text: "hi" },
        { root: process.cwd() },
      );
      expect(result).toEqual({ content: "echo: hi", isError: false });

      // Resources are available from the same connection without a reload.
      const resourceTools = createMcpResourceTools({
        servers: connection.resources,
      });
      const readResource = resourceTools.find(
        (tool) => tool.name === "mcp_read_resource",
      );
      const resource = await readResource!.execute(
        { server: "fixture", uri: "fixture://hello" },
        { root: process.cwd() },
      );
      expect(resource.content).toContain("MCP server: fixture");
      expect(resource.content).toContain("hello resource");
    } finally {
      await connection.close();
    }

    // Closing twice must be harmless: every exit path may race.
    await connection.close();
  });

  it("skips a server that fails to start without dropping the others", async () => {
    const connection = await connectMcpServers({
      servers: {
        good: stdioServer(),
        bad: {
          type: "stdio",
          command: path.join(
            process.cwd(),
            "definitely-missing",
            "cooper-mcp-test",
          ),
        },
      },
      connectTimeoutMs: 10_000,
    });

    try {
      const statuses = Object.fromEntries(
        connection.statuses.map((status) => [status.name, status]),
      );
      expect(statuses["good"]?.ok).toBe(true);
      expect(statuses["bad"]?.ok).toBe(false);
      expect(statuses["bad"]?.error).toBeTruthy();
      expect(connection.tools.map((tool) => tool.name)).toEqual([
        "mcp__good__echo",
      ]);
    } finally {
      await connection.close();
    }
  }, 20_000);
});
