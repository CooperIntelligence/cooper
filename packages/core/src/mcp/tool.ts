import crypto from "node:crypto";
import { z } from "zod";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Tool, ToolContext, ToolResult } from "../tools/tool.js";

/** The subset of an MCP tool definition Cooper needs. */
export type McpToolDefinition = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
};

export type McpToolOptions = {
  serverName: string;
  definition: McpToolDefinition;
  client: Client;
  /** Per-call timeout; MCP calls can run longer than simple file reads. */
  callTimeoutMs?: number;
  /** Keep a single result from consuming the whole context budget. */
  maxOutputChars?: number;
};

const DEFAULT_CALL_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_CHARS = 30_000;
const MAX_TOOL_NAME_LENGTH = 64;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_");
}

/**
 * OpenAI-compatible providers cap function names at 64 characters. The server
 * and tool names are untrusted, so sanitize and hash-truncate long names
 * instead of letting them collide or be rejected.
 */
export function mcpToolName(serverName: string, toolName: string): string {
  const base = `mcp__${safeSegment(serverName)}__${safeSegment(toolName)}`;
  if (base.length <= MAX_TOOL_NAME_LENGTH) return base;
  const hash = crypto.createHash("sha1").update(base).digest("hex").slice(0, 8);
  return `${base.slice(0, MAX_TOOL_NAME_LENGTH - 9)}_${hash}`;
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[truncated at ${maxChars} characters]`;
}

function formatBlock(block: unknown): string {
  if (!isRecord(block)) return "";
  const type = block["type"];

  if (type === "text" && typeof block["text"] === "string") {
    return block["text"];
  }

  if (type === "image" || type === "audio") {
    const mime = typeof block["mimeType"] === "string" ? block["mimeType"] : "unknown";
    const size =
      typeof block["data"] === "string"
        ? `, ${block["data"].length} base64 chars`
        : "";
    return `[${type}: ${mime}${size}]`;
  }

  if (type === "resource" && isRecord(block["resource"])) {
    const resource = block["resource"];
    const uri = typeof resource["uri"] === "string" ? resource["uri"] : "?";
    if (typeof resource["text"] === "string") return resource["text"];
    const mime =
      typeof resource["mimeType"] === "string" ? resource["mimeType"] : "blob";
    return `[resource: ${uri} (${mime})]`;
  }

  if (type === "resource_link") {
    const uri = typeof block["uri"] === "string" ? block["uri"] : "?";
    const name = typeof block["name"] === "string" ? block["name"] : "";
    return `[resource link: ${uri}${name.length > 0 ? ` (${name})` : ""}]`;
  }

  return `[${String(type ?? "unknown")} content]`;
}

/**
 * Flattens MCP's content-block result into the text-only ToolResult Cooper
 * uses. Images/audio become placeholders because the TUI has no renderer for
 * them yet; structured content is used when no text blocks were returned.
 */
export function formatMcpResult(
  result: unknown,
  maxChars = DEFAULT_MAX_OUTPUT_CHARS,
): ToolResult {
  if (!isRecord(result)) {
    return { content: truncate(String(result), maxChars) };
  }

  const isError = result["isError"] === true;

  if (Array.isArray(result["content"])) {
    const parts = result["content"]
      .map(formatBlock)
      .filter((part) => part.length > 0);
    if (parts.length > 0) {
      return { content: truncate(parts.join("\n"), maxChars), isError };
    }
  }

  if (result["structuredContent"] !== undefined) {
    return {
      content: truncate(JSON.stringify(result["structuredContent"], null, 2), maxChars),
      isError,
    };
  }

  if ("toolResult" in result) {
    return {
      content: truncate(JSON.stringify(result["toolResult"]), maxChars),
      isError,
    };
  }

  return { content: "(no output)", isError };
}

/**
 * Adapts one MCP tool into the shared Tool interface.
 *
 * Capabilities are always `execute`: server-provided annotations such as
 * `readOnlyHint` are not trusted, so plan mode can never be bypassed by a
 * mislabeled remote tool. MCP's raw JSON Schema is forwarded to the model; the
 * permissive zod parser only guarantees the argument is an object.
 */
export function createMcpTool(options: McpToolOptions): Tool {
  const {
    serverName,
    definition,
    client,
    callTimeoutMs = DEFAULT_CALL_TIMEOUT_MS,
    maxOutputChars = DEFAULT_MAX_OUTPUT_CHARS,
  } = options;

  const name = mcpToolName(serverName, definition.name);

  return {
    name,
    description:
      definition.description !== undefined && definition.description.length > 0
        ? definition.description
        : `MCP tool ${definition.name} from ${serverName}`,
    inputSchema: z.record(z.string(), z.unknown()),
    jsonSchema: definition.inputSchema,
    capabilities: ["execute"],
    summarize(input) {
      let detail = "";
      try {
        detail = JSON.stringify(input);
      } catch {
        detail = "";
      }
      if (detail === "" || detail === "{}") {
        return `MCP ${serverName} · ${definition.name}`;
      }
      const flat = detail.replace(/\s+/g, " ");
      return `MCP ${serverName} · ${definition.name} ${flat.length > 120 ? `${flat.slice(0, 119)}…` : flat}`;
    },
    async execute(input, ctx: ToolContext): Promise<ToolResult> {
      const result = await client.callTool(
        {
          name: definition.name,
          arguments: input as Record<string, unknown>,
        },
        undefined,
        { timeout: callTimeoutMs, signal: ctx.signal },
      );
      return formatMcpResult(result, maxOutputChars);
    },
  };
}
