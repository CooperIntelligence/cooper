import fs from "node:fs";
import path from "node:path";
import { cooperHome } from "../home.js";

/**
 * MCP server configuration.
 *
 * Starting an MCP server executes a command or opens a network connection, so
 * configuration is trusted input. Only the user-level file and explicit
 * `--mcp-config` paths load by default; a workspace file needs an explicit
 * opt-in (`--mcp-project`) so cloning a repository cannot run anything.
 */

export type McpServerConfig =
  | {
      type: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
      cwd?: string;
    }
  | { type: "http"; url: string; headers?: Record<string, string> }
  | { type: "sse"; url: string; headers?: Record<string, string> };

export type LoadMcpConfigOptions = {
  /** Workspace root, used for the project config and relative explicit paths. */
  root: string;
  /** Overrides the `cooperHome()` anchor; tests only. */
  home?: string;
  /** Explicit config files (repeatable CLI flag). Missing files are errors. */
  explicit?: string[];
  /** Load `<root>/.cooper/mcp.json`. */
  loadProject?: boolean;
};

export type LoadedMcpConfig = {
  servers: Record<string, McpServerConfig>;
  /** Files that contributed at least one server definition. */
  sources: string[];
  warnings: string[];
};

const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return null;
  }
  return value;
}

function stringRecord(value: unknown): Record<string, string> | null {
  if (value === undefined) return {};
  if (!isRecord(value)) return null;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") return null;
    out[key] = item;
  }
  return out;
}

type ParseResult = {
  servers: Record<string, McpServerConfig>;
  warnings: string[];
};

function parseServer(
  name: string,
  raw: unknown,
  file: string,
): McpServerConfig | string {
  if (!isRecord(raw)) return `server "${name}" is not an object`;

  const type = raw["type"];
  if (type === "http" || type === "sse") {
    if (typeof raw["url"] !== "string") {
      return `server "${name}" is missing a url`;
    }
    let url: URL;
    try {
      url = new URL(raw["url"]);
    } catch {
      return `server "${name}" has an invalid url`;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return `server "${name}" must use http or https`;
    }
    const headers = stringRecord(raw["headers"]);
    if (headers === null) return `server "${name}" has invalid headers`;
    return { type, url: url.toString(), headers };
  }

  if (type !== undefined && type !== "stdio") {
    return `server "${name}" has unknown type "${String(type)}"`;
  }
  if (typeof raw["command"] !== "string" || raw["command"].trim() === "") {
    return `server "${name}" is missing a command`;
  }
  const args = stringArray(raw["args"]);
  if (args === null) return `server "${name}" has invalid args`;
  const env = stringRecord(raw["env"]);
  if (env === null) return `server "${name}" has invalid env`;
  if (raw["cwd"] !== undefined && typeof raw["cwd"] !== "string") {
    return `server "${name}" has an invalid cwd`;
  }

  const config: Extract<McpServerConfig, { type: "stdio" }> = {
    type: "stdio",
    command: raw["command"],
    args,
    env,
  };
  if (typeof raw["cwd"] === "string") {
    config.cwd = path.resolve(path.dirname(file), raw["cwd"]);
  }
  return config;
}

function parseFile(file: string): ParseResult {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(
      `Cannot read MCP config ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `Invalid JSON in MCP config ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!isRecord(value) || !isRecord(value["mcpServers"])) {
    throw new Error(
      `MCP config ${file} must contain an "mcpServers" object.`,
    );
  }

  const servers: Record<string, McpServerConfig> = {};
  const warnings: string[] = [];

  for (const [name, raw] of Object.entries(value["mcpServers"])) {
    if (!SERVER_NAME.test(name)) {
      warnings.push(
        `${file}: server name "${name}" is invalid (use letters, digits, ".", "_", "-").`,
      );
      continue;
    }
    const parsed = parseServer(name, raw, file);
    if (typeof parsed === "string") {
      warnings.push(`${file}: ${parsed}.`);
      continue;
    }
    servers[name] = parsed;
  }

  return { servers, warnings };
}

/**
 * Loads user, (optionally) project, and explicit MCP configs. Later files
 * override earlier ones by server name, so an explicit `--mcp-config` can
 * replace a user-level server.
 */
export function loadMcpConfig(options: LoadMcpConfigOptions): LoadedMcpConfig {
  const root = path.resolve(options.root);
  // `cooperHome()` is the fixed `~/.cooper` anchor, so the user config sits
  // directly inside it.
  const home = options.home ?? cooperHome();
  const userFile = path.join(home, "mcp.json");
  const projectFile = path.join(root, ".cooper", "mcp.json");

  const servers: Record<string, McpServerConfig> = {};
  const sources: string[] = [];
  const warnings: string[] = [];

  const apply = (file: string, required: boolean) => {
    if (!fs.existsSync(file)) {
      if (required) throw new Error(`MCP config not found: ${file}`);
      return;
    }
    const parsed = parseFile(file);
    Object.assign(servers, parsed.servers);
    warnings.push(...parsed.warnings);
    if (parsed.servers && Object.keys(parsed.servers).length > 0) {
      if (!sources.includes(file)) sources.push(file);
    }
  };

  apply(userFile, false);

  if (options.loadProject === true) {
    apply(projectFile, false);
  } else if (fs.existsSync(projectFile)) {
    warnings.push(
      `Project MCP config ignored: ${projectFile}. Pass --mcp-project to load it.`,
    );
  }

  for (const file of options.explicit ?? []) {
    apply(path.resolve(file), true);
  }

  return { servers, sources, warnings };
}
