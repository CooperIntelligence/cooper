import type { SessionSummary } from "@cooper/core";
import type { ApprovalMode } from "./config.js";
import type { McpReport } from "./mcp.js";

export type CommandName =
  | ApprovalMode
  | "help"
  | "clear"
  | "compact"
  | "sessions"
  | "resume"
  | "mcp"
  | "tools"
  | "exit";

export type CommandSpec = {
  name: CommandName;
  /** Alternative names that resolve to `name`. */
  aliases: string[];
  /** Canonical invocation shown in help, e.g. `/clear`. */
  usage: string;
  description: string;
};

/**
 * Single source of truth for TUI slash commands: parsing (via aliases),
 * help text, and the handler switch in app.tsx all key off this list.
 */
export const COMMANDS: readonly CommandSpec[] = [
  {
    name: "help",
    aliases: [],
    usage: "/help",
    description: "show this help",
  },
  {
    name: "plan",
    aliases: [],
    usage: "/plan",
    description: "read-only planning mode",
  },
  {
    name: "ask",
    aliases: [],
    usage: "/ask",
    description: "approve writes and commands",
  },
  {
    name: "auto",
    aliases: [],
    usage: "/auto",
    description: "auto-approve ALL tools",
  },
  {
    name: "clear",
    aliases: ["new", "reset"],
    usage: "/clear",
    description: "start a new conversation (aliases /new /reset)",
  },
  {
    name: "compact",
    aliases: [],
    usage: "/compact",
    description: "compact context now if above the summarize threshold",
  },
  {
    name: "sessions",
    aliases: [],
    usage: "/sessions",
    description: "list saved sessions for this workspace",
  },
  {
    name: "resume",
    aliases: [],
    usage: "/resume <id>",
    description: "switch to a saved session (unique id prefix works)",
  },
  {
    name: "mcp",
    aliases: [],
    usage: "/mcp",
    description: "show MCP server status",
  },
  {
    name: "tools",
    aliases: [],
    usage: "/tools",
    description: "list tools and their capabilities",
  },
  {
    name: "exit",
    aliases: [],
    usage: "/exit",
    description: "quit the TUI",
  },
];

const ALIASES: ReadonlyMap<string, CommandName> = new Map(
  COMMANDS.flatMap((spec) => [
    [spec.name, spec.name] as const,
    ...spec.aliases.map(
      (alias) => [alias, spec.name] as const,
    ),
  ]),
);

export type ParsedCommand =
  | { kind: "prompt"; text: string }
  | { kind: "command"; name: CommandName; args: string }
  | { kind: "unknown"; name: string };

/** Parses the TUI's slash-command prefix. Anything else is a model prompt. */
export function parseCommand(input: string): ParsedCommand {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return { kind: "prompt", text: input };

  const match = /^([^\s]*)(?:\s+([\s\S]*))?$/.exec(trimmed.slice(1));
  const rawName = (match?.[1] ?? "").toLowerCase();
  const args = (match?.[2] ?? "").trim();
  const name = ALIASES.get(rawName);
  if (name === undefined) return { kind: "unknown", name: rawName };
  return { kind: "command", name, args };
}

export function isModeCommand(name: CommandName): name is ApprovalMode {
  return name === "plan" || name === "ask" || name === "auto";
}

export function modeDescription(mode: ApprovalMode): string {
  if (mode === "plan") return "plan (read-only)";
  if (mode === "auto") return "auto (auto-approve ALL tools)";
  return "ask (approve writes and commands)";
}

export function commandHelp(mode: ApprovalMode): string {
  const width = Math.max(...COMMANDS.map((spec) => spec.usage.length));
  const lines = [`Commands · current mode: ${modeDescription(mode)}`];
  for (const spec of COMMANDS) {
    lines.push(`${spec.usage.padEnd(width)}  ${spec.description}`);
  }
  return lines.join("\n");
}

export function formatSessions(
  sessions: readonly SessionSummary[],
): string {
  if (sessions.length === 0) return "No saved sessions for this workspace.";
  const lines = [`${sessions.length} session(s), newest first:`];
  for (const entry of sessions) {
    const when = new Date(entry.updatedAt).toLocaleString();
    lines.push(`  ${entry.id}  ${when}  ${entry.model}  ${entry.preview}`);
  }
  lines.push("Resume with: cooper --resume <id>");
  return lines.join("\n");
}

export function formatMcp(mcp: McpReport): string {
  const lines: string[] = [];
  if (mcp.sources.length > 0) {
    lines.push(`Sources: ${mcp.sources.join(", ")}`);
  }
  if (mcp.statuses.length === 0) {
    lines.push(mcp.warnings.length > 0 ? "No servers loaded." : "No MCP servers configured.");
  }
  for (const status of mcp.statuses) {
    lines.push(
      status.ok
        ? `  ${status.name}  ok · ${status.toolCount} tool(s)`
        : `  ${status.name}  failed · ${status.error ?? "unknown error"}`,
    );
  }
  for (const warning of mcp.warnings) {
    lines.push(`  warning: ${warning}`);
  }
  return lines.join("\n");
}

export function formatTools(
  tools: readonly { name: string; capabilities: readonly string[] }[],
): string {
  if (tools.length === 0) return "No tools available.";
  const width = Math.max(...tools.map((tool) => tool.name.length));
  const lines = [`${tools.length} tool(s):`];
  for (const tool of tools) {
    lines.push(`  ${tool.name.padEnd(width)}  ${tool.capabilities.join("/")}`);
  }
  return lines.join("\n");
}
