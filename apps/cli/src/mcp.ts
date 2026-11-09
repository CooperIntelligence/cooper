import {
  allTools,
  connectMcpServers,
  loadMcpConfig,
  type McpServerStatus,
  type Tool,
} from "@cooper/core";

/** What the surfaces show about MCP startup. */
export type McpReport = {
  sources: string[];
  statuses: McpServerStatus[];
  warnings: string[];
};

export type PreparedTools = {
  tools: Tool[];
  mcp: McpReport;
  close(): Promise<void>;
};

/**
 * Loads trusted MCP config, connects servers, and returns built-in + MCP
 * tools. A bad server is reported and skipped; only config errors are fatal.
 * The caller owns `close()` and must call it on every exit path.
 */
export async function prepareTools(options: {
  root: string;
  explicit: string[];
  loadProject: boolean;
}): Promise<PreparedTools> {
  const config = loadMcpConfig(options);
  const base: McpReport = {
    sources: config.sources,
    statuses: [],
    warnings: config.warnings,
  };

  if (Object.keys(config.servers).length === 0) {
    return {
      tools: allTools,
      mcp: base,
      close: async () => {},
    };
  }

  const connection = await connectMcpServers({
    servers: config.servers,
  });

  return {
    tools: [...allTools, ...connection.tools],
    mcp: {
      sources: config.sources,
      statuses: connection.statuses,
      warnings: [...config.warnings, ...connection.warnings],
    },
    close: () => connection.close(),
  };
}
