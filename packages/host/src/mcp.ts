import path from "node:path";
import {
  allTools,
  connectMcpServers,
  createBuiltinTools,
  createMcpResourceTools,
  createWebSearchTool,
  loadMcpConfig,
  type CommandShell,
  type McpServerStatus,
  type Tool,
} from "@cooper/core";
import type { WebSearchConfig } from "./config.js";

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

export function configureWebSearchTool(tools: Tool[], config: WebSearchConfig = {}): Tool[] {
  const index = tools.findIndex((tool) => tool.name === "web_search");
  if (config === false) {
    return index === -1 ? tools : tools.filter((_, position) => position !== index);
  }
  const search = createWebSearchTool(config.apiKey);
  return index === -1 ? [...tools, search] : tools.map((tool, position) => position === index ? search : tool);
}

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
  webSearch?: WebSearchConfig;
  /** Overrides the `cooperHome()` anchor; tests only. */
  home?: string;
}): Promise<PreparedTools> {
  const config = loadMcpConfig(options);
  const builtins = configureWebSearchTool(options.shell ? createBuiltinTools(options.shell) : [...allTools], options.webSearch);
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

  const servers = Object.fromEntries(Object.entries(config.servers).map(([name, server]) => [
    name,
    server.type === "stdio"
      ? { ...server, cwd: path.resolve(options.root, server.cwd ?? ".") }
      : server,
  ]));
  const connection = await connectMcpServers({ servers });

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
