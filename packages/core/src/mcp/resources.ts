import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../tools/tool.js";

/**
 * MCP resources are exposed as three shared model-facing tools instead of one
 * adapter per server. Every call names a configured server explicitly, and
 * resource content is read only when the model asks for it: connecting a
 * server never injects its documents into the prompt.
 */

const DEFAULT_CALL_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_CHARS = 30_000;
const MAX_LIST_PAGES = 100;

/** Resource access owned by one live MCP connection. */
export type McpResourceProvider = {
  readonly serverName: string;
  /** Whether the server advertised the `resources` capability. */
  readonly supportsResources: boolean;
  /**
   * Lists resources. Omitting `cursor` aggregates every page; supplying one
   * returns exactly that page and preserves the server's opaque cursor.
   */
  list(cursor?: string, signal?: AbortSignal): Promise<unknown>;
  /** Same paging contract as {@link list}, for resource templates. */
  listTemplates(cursor?: string, signal?: AbortSignal): Promise<unknown>;
  /** Reads one resource URI. */
  read(uri: string, signal?: AbortSignal): Promise<unknown>;
};

export type CreateResourceProviderOptions = {
  callTimeoutMs?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function oneLine(text: string, max = 100): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[truncated at ${maxChars} characters]`;
}

/**
 * Keeps resource results structured for the model but never inlines binary
 * payloads: a base64 `blob` becomes a short description, matching the policy
 * MCP tool results already use.
 */
function projectBlobs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(projectBlobs);
  if (!isRecord(value)) return value;

  const projected: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    projected[key] =
      key === "blob" && typeof item === "string"
        ? `[binary resource: ${item.length} base64 characters; available to programmatic callers]`
        : projectBlobs(item);
  }
  return projected;
}

/** Renders one resource result with the server name the model must reuse. */
export function formatResourceResult(
  serverName: string,
  value: unknown,
  maxChars = DEFAULT_MAX_OUTPUT_CHARS,
): ToolResult {
  const projected = projectBlobs(value);
  const body =
    typeof projected === "string"
      ? projected
      : (JSON.stringify(projected, null, 2) ?? String(projected));
  return {
    content: truncate(`MCP server: ${serverName}\n${body}`, maxChars),
  };
}

async function collectPages<T>(
  fetchPage: (cursor: string | undefined) => Promise<{
    items: T[];
    nextCursor?: string;
  }>,
  label: string,
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;

  for (let pageCount = 0; pageCount < MAX_LIST_PAGES; pageCount += 1) {
    const page = await fetchPage(cursor);
    items.push(...page.items);
    cursor = page.nextCursor;
    if (cursor === undefined || cursor.length === 0) return items;
  }

  throw new Error(`MCP server returned too many ${label} pages.`);
}

/**
 * Wraps a connected client in the narrow resource surface the shared tools
 * need. Servers without the `resources` capability still get a provider so
 * their name stays selectable; lists are empty and reads fail explicitly.
 */
export function createResourceProvider(
  serverName: string,
  client: Client,
  options: CreateResourceProviderOptions = {},
): McpResourceProvider {
  const timeout = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const supportsResources =
    client.getServerCapabilities()?.resources !== undefined;

  return {
    serverName,
    supportsResources,

    async list(cursor, signal) {
      if (!supportsResources) return { resources: [] };
      if (cursor !== undefined) {
        return client.listResources({ cursor }, { timeout, signal });
      }
      const resources = await collectPages(async (next) => {
        const page = await client.listResources(
          next === undefined ? undefined : { cursor: next },
          { timeout, signal },
        );
        return { items: page.resources, nextCursor: page.nextCursor };
      }, "resource");
      return { resources };
    },

    async listTemplates(cursor, signal) {
      if (!supportsResources) return { resourceTemplates: [] };
      if (cursor !== undefined) {
        return client.listResourceTemplates({ cursor }, { timeout, signal });
      }
      const resourceTemplates = await collectPages(async (next) => {
        const page = await client.listResourceTemplates(
          next === undefined ? undefined : { cursor: next },
          { timeout, signal },
        );
        return {
          items: page.resourceTemplates,
          nextCursor: page.nextCursor,
        };
      }, "resource template");
      return { resourceTemplates };
    },

    async read(uri, signal) {
      if (!supportsResources) {
        throw new Error(
          `MCP server "${serverName}" does not support resources.`,
        );
      }
      return client.readResource({ uri }, { timeout, signal });
    },
  };
}

export type CreateMcpResourceToolsOptions = {
  /** One provider per configured server name. */
  servers: ReadonlyMap<string, McpResourceProvider>;
  maxOutputChars?: number;
};

/**
 * Builds the shared resource tools. Returns an empty list when no server is
 * configured, so sessions without MCP pay no schema or prompt token cost.
 */
export function createMcpResourceTools(
  options: CreateMcpResourceToolsOptions,
): Tool[] {
  const serverNames = [...options.servers.keys()];
  if (serverNames.length === 0) return [];

  const maxOutputChars =
    options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  const serverList = serverNames.join(", ");
  const serverHint = `Configured MCP servers: ${serverList}.`;

  function providerFor(server: string): McpResourceProvider {
    const provider = options.servers.get(server);
    if (provider === undefined) {
      throw new Error(
        `Unknown MCP server "${server}". Configured servers: ${serverList}.`,
      );
    }
    return provider;
  }

  const listInput = z.object({
    server: z.string().min(1).describe(serverHint),
    cursor: z
      .string()
      .min(1)
      .optional()
      .describe("Continuation cursor returned by this server."),
  });

  const readInput = z.object({
    server: z.string().min(1).describe(serverHint),
    uri: z.string().min(1).describe("Resource URI to read."),
  });

  const listResources: Tool<typeof listInput> = {
    name: "mcp_list_resources",
    description:
      `List resources available from a configured MCP server. ${serverHint} ` +
      "Omit cursor to aggregate every page, or pass the opaque nextCursor to read one page.",
    inputSchema: listInput,
    capabilities: ["read"],
    summarize(input) {
      return `MCP resources · ${input.server}`;
    },
    async execute(input: z.infer<typeof listInput>, ctx: ToolContext) {
      const result = await providerFor(input.server).list(
        input.cursor,
        ctx.signal,
      );
      return formatResourceResult(input.server, result, maxOutputChars);
    },
  };

  const listTemplates: Tool<typeof listInput> = {
    name: "mcp_list_resource_templates",
    description:
      `List parameterized resource URI templates from a configured MCP server. ${serverHint} ` +
      "Omit cursor to aggregate every page, or pass the opaque nextCursor to read one page.",
    inputSchema: listInput,
    capabilities: ["read"],
    summarize(input) {
      return `MCP resource templates · ${input.server}`;
    },
    async execute(input: z.infer<typeof listInput>, ctx: ToolContext) {
      const result = await providerFor(input.server).listTemplates(
        input.cursor,
        ctx.signal,
      );
      return formatResourceResult(input.server, result, maxOutputChars);
    },
  };

  const readResource: Tool<typeof readInput> = {
    name: "mcp_read_resource",
    description:
      `Read an MCP resource by URI from a configured MCP server. ${serverHint} ` +
      "Use a listed URI or an expanded resource template.",
    inputSchema: readInput,
    capabilities: ["read"],
    summarize(input) {
      return `MCP resource · ${input.server} · ${oneLine(input.uri)}`;
    },
    async execute(input: z.infer<typeof readInput>, ctx: ToolContext) {
      const result = await providerFor(input.server).read(
        input.uri,
        ctx.signal,
      );
      return formatResourceResult(input.server, result, maxOutputChars);
    },
  };

  return [listResources, listTemplates, readResource];
}
