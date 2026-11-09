import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool } from "../tools/tool.js";
import type { McpServerConfig } from "./config.js";
import {
  createMcpTool,
  type McpToolDefinition,
} from "./tool.js";

export type McpServerStatus = {
  name: string;
  ok: boolean;
  toolCount: number;
  /** Connection/list failure, including a short stderr tail for stdio. */
  error?: string;
};

export type McpConnection = {
  tools: Tool[];
  statuses: McpServerStatus[];
  /** Non-fatal issues (duplicate tool names, ignored project config, ...). */
  warnings: string[];
  close(): Promise<void>;
};

export type ConnectMcpOptions = {
  servers: Record<string, McpServerConfig>;
  connectTimeoutMs?: number;
  callTimeoutMs?: number;
  maxOutputChars?: number;
};

export type ListMcpToolsOptions = {
  /** Timeout for each listTools page. */
  timeoutMs?: number;
  callTimeoutMs?: number;
  maxOutputChars?: number;
};

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_CALL_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_CHARS = 30_000;
const CLIENT_INFO = { name: "cooper", version: "0.1.0" };
const STDERR_TAIL_CHARS = 2_000;

type CreatedTransport = {
  transport: Transport;
  /** Last stderr output, for a useful failure message. */
  stderr(): string;
};

function isStdioConfig(
  config: McpServerConfig,
): config is Extract<McpServerConfig, { type: "stdio" }> {
  return config.type === "stdio";
}

function createTransport(config: McpServerConfig): CreatedTransport {
  if (isStdioConfig(config)) {
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      // The SDK's default environment omits most user variables; merge the
      // configured ones on top so commands can still find PATH/HOME.
      env: { ...getDefaultEnvironment(), ...(config.env ?? {}) },
      cwd: config.cwd,
      // Keep server logs away from the TUI, but retain a tail for errors.
      stderr: "pipe",
    });

    let tail = "";
    transport.stderr?.on("data", (chunk: Buffer | string) => {
      tail = (tail + chunk.toString()).slice(-STDERR_TAIL_CHARS);
    });

    return { transport, stderr: () => tail };
  }

  const url = new URL(config.url);
  const requestInit =
    config.headers !== undefined && Object.keys(config.headers).length > 0
      ? { headers: config.headers }
      : undefined;

  return {
    transport:
      config.type === "sse"
        ? new SSEClientTransport(url, { requestInit })
        : new StreamableHTTPClientTransport(url, { requestInit }),
    stderr: () => "",
  };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function listDefinitions(
  client: Client,
  timeoutMs: number,
): Promise<McpToolDefinition[]> {
  const definitions: McpToolDefinition[] = [];
  let cursor: string | undefined;

  // A broken or hostile server could return the same cursor forever.
  for (let pageCount = 0; pageCount < 100; pageCount += 1) {
    const page = await client.listTools(
      cursor !== undefined ? { cursor } : undefined,
      { timeout: timeoutMs },
    );
    for (const tool of page.tools) {
      definitions.push({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      });
    }
    cursor = page.nextCursor ?? undefined;
    if (cursor === undefined || cursor.length === 0) return definitions;
  }

  throw new Error("MCP server returned too many tool-list pages.");
}

/**
 * Lists an already-connected server's tools and adapts them. Exported so the
 * adapter can be tested with an in-memory transport.
 */
export async function listMcpTools(
  serverName: string,
  client: Client,
  options: ListMcpToolsOptions = {},
): Promise<{ tools: Tool[]; warnings: string[] }> {
  const definitions = await listDefinitions(
    client,
    options.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
  );
  const warnings: string[] = [];
  const seen = new Set<string>();
  const tools: Tool[] = [];

  for (const definition of definitions) {
    const tool = createMcpTool({
      serverName,
      definition,
      client,
      callTimeoutMs: options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
      maxOutputChars: options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS,
    });
    if (seen.has(tool.name)) {
      warnings.push(
        `MCP server "${serverName}" exposes duplicate tool name ${tool.name}; the later definition was skipped.`,
      );
      continue;
    }
    seen.add(tool.name);
    tools.push(tool);
  }

  return { tools, warnings };
}

type ServerResult = {
  client: Client | null;
  tools: Tool[];
  warnings: string[];
  status: McpServerStatus;
};

async function connectServer(
  name: string,
  config: McpServerConfig,
  options: Required<Pick<ConnectMcpOptions, "connectTimeoutMs" | "callTimeoutMs" | "maxOutputChars">>,
): Promise<ServerResult> {
  let created: CreatedTransport | null = null;
  const client = new Client(CLIENT_INFO, { capabilities: {} });

  try {
    created = createTransport(config);
    await withTimeout(
      client.connect(created.transport),
      options.connectTimeoutMs,
      `MCP server "${name}" connect`,
    );

    const listed = await listMcpTools(name, client, {
      timeoutMs: options.connectTimeoutMs,
      callTimeoutMs: options.callTimeoutMs,
      maxOutputChars: options.maxOutputChars,
    });

    return {
      client,
      tools: listed.tools,
      warnings: listed.warnings,
      status: { name, ok: true, toolCount: listed.tools.length },
    };
  } catch (error) {
    await client.close().catch(() => {});
    const tail = created?.stderr().trim() ?? "";
    const message = error instanceof Error ? error.message : String(error);
    return {
      client: null,
      tools: [],
      warnings: [],
      status: {
        name,
        ok: false,
        toolCount: 0,
        error:
          tail.length > 0
            ? `${message}\n${tail.slice(-500)}`
            : message,
      },
    };
  }
}

/**
 * Connects every configured server in parallel. A failed server is reported
 * and skipped; it never prevents built-in tools from running.
 */
export async function connectMcpServers(
  options: ConnectMcpOptions,
): Promise<McpConnection> {
  const connectTimeoutMs =
    options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;

  const names = Object.keys(options.servers);
  const results = await Promise.all(
    names.map((name) => {
      const config = options.servers[name];
      if (config === undefined) {
        return Promise.resolve<ServerResult>({
          client: null,
          tools: [],
          warnings: [],
          status: { name, ok: false, toolCount: 0, error: "missing config" },
        });
      }
      return connectServer(name, config, {
        connectTimeoutMs,
        callTimeoutMs,
        maxOutputChars,
      });
    }),
  );

  const clients = results
    .map((result) => result.client)
    .filter((client): client is Client => client !== null);
  let closed = false;

  // Names are namespaced by server, but two server names can sanitize to the
  // same prefix (for example "a.b" and "a_b"). Keep the first definition so a
  // later server cannot silently shadow a tool the model already saw.
  const seen = new Set<string>();
  const tools: Tool[] = [];
  const warnings = results.flatMap((result) => result.warnings);
  for (const result of results) {
    for (const tool of result.tools) {
      if (seen.has(tool.name)) {
        warnings.push(
          `Duplicate MCP tool name ${tool.name}; the later definition was skipped.`,
        );
        continue;
      }
      seen.add(tool.name);
      tools.push(tool);
    }
  }

  return {
    tools,
    statuses: results.map((result) => result.status),
    warnings,
    async close() {
      if (closed) return;
      closed = true;
      await Promise.allSettled(clients.map((client) => client.close()));
    },
  };
}
