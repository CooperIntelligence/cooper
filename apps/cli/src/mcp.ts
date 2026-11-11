import {
  allTools,
  connectMcpServers,
  createBuiltinTools,
  createMcpResourceTools,
  loadMcpConfig,
  type CommandShell,
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
  shell?: CommandShell;
  /** Overrides the `cooperHome()` anchor; tests only. */
  home?: string;
}): Promise<PreparedTools> {
  const config = loadMcpConfig(options);
  const builtins = options.shell ? createBuiltinTools(options.shell) : allTools;
  const base: McpReport = {
    sources: config.sources,
    statuses: [],
    warnings: config.warnings,
  };

  if (Object.keys(config.servers).length === 0) {
    return {
      tools: builtins,
      mcp: base,
      close: async () => {},
    };
  }

  const connection = await connectMcpServers({
    servers: config.servers,
  });

  return {
    tools: [
      ...builtins,
      ...connection.tools,
      ...createMcpResourceTools({ servers: connection.resources }),
    ],
    mcp: {
      sources: config.sources,
      statuses: connection.statuses,
      warnings: [...config.warnings, ...connection.warnings],
    },
    close: () => connection.close(),
  };
}
