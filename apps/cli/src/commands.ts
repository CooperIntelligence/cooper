import { modelTierNames, type ModelTier, type SessionSummary } from "@cooper/core";
import type { ModeResolution } from "./args.js";
import type { ApprovalMode, Config, ConfigSource } from "@cooper/host";
import { describeModel } from "@cooper/host";
import type { McpReport } from "@cooper/host";
import {
  BUILTIN_COMMANDS, filterCommands as filterRegisteredCommands, parseCommand as parseRegisteredCommand,
  type BuiltinCommandName, type CommandSpec as RegisteredCommandSpec, type ParsedCommand as RegisteredCommand,
} from "@cooper/host/commands";

export { commandArgsOf, completeCommand } from "@cooper/host/commands";

export type CommandName = BuiltinCommandName | ModelTier;
export type CommandSpec = RegisteredCommandSpec<CommandName>;
export type ParsedCommand = RegisteredCommand<CommandName>;

export const COMMANDS: readonly CommandSpec[] = [
  ...BUILTIN_COMMANDS,
  ...(Object.entries(modelTierNames) as [ModelTier, string][]).map(([name, title]) => ({
    name, aliases: [], usage: `/${name}`, description: `switch to ${title}`,
  })),
];

export function parseCommand(input: string): ParsedCommand {
  return parseRegisteredCommand(input, COMMANDS);
}

export function filterCommands(input: string): CommandSpec[] {
  return filterRegisteredCommands(input, COMMANDS);
}

export function isModeCommand(name: CommandName): name is ApprovalMode {
  return name === "plan" || name === "ask" || name === "auto";
}

export function modeDescription(mode: ApprovalMode): string {
  if (mode === "plan") return "plan (read-only)";
  if (mode === "auto") return "auto (sandbox required for shell)";
  return "ask (approve writes, commands, and web requests)";
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

export function formatStatus(options: {
  config: Config;
  mode: ApprovalMode;
  modeSource: ModeResolution["source"] | "command";
  contextTokens: number;
}): string {
  const { config, mode, modeSource, contextTokens } = options;
  const window = config.context.window;
  const contextPercent = ((contextTokens / window) * 100).toFixed(1);

  const configSourceLabel = (source: ConfigSource | undefined): string => {
    switch (source) {
      case "flag":
        return "flag";
      case "config":
        return "config file";
      default:
        return "default";
    }
  };
  const modeSourceLabel: Record<string, string> = {
    flag: "flag",
    session: "session",
    config: "config file",
    default: "default",
    command: "command",
  };

  const entries: [name: string, value: string, source: string][] = [
    ["protocol", config.protocol, configSourceLabel(config.sources.protocol)],
    ["model", config.model, configSourceLabel(config.sources.model)],
    ["shell", `${config.shell.kind} (${config.shell.executable})`, configSourceLabel(config.sources.shell)],
    [
      "baseURL",
      config.baseURL,
      configSourceLabel(config.sources.baseURL),
    ],
    ["apiKey", "set", configSourceLabel(config.sources.apiKey)],
    [
      "maxOutputTokens",
      config.modelSelection?.tier && config.modelSelection.maxOutputTokens === undefined ||
      config.protocol === "openai-responses" && config.sources.maxOutputTokens !== "config"
        ? "provider default"
        : String(config.maxOutputTokens),
      configSourceLabel(config.sources.maxOutputTokens),
    ],
    [
      "showReasoning",
      config.showReasoning ? "on" : "off",
      configSourceLabel(config.sources.showReasoning),
    ],
    [
      "context.window",
      `${config.context.window}${config.contextWindowAssumed ? " (assumed)" : ""}`,
      configSourceLabel(config.sources["context.window"]),
    ],
    [
      "context.reserveOutputTokens",
      String(config.context.reserveOutputTokens),
      configSourceLabel(config.sources["context.reserveOutputTokens"]),
    ],
    [
      "context.compact",
      config.context.enabled ? "on" : "off",
      configSourceLabel(config.sources["context.compact"]),
    ],
    [
      "context.summaryModel",
      config.context.summaryModel ?? "(same as model)",
      configSourceLabel(config.sources["context.summaryModel"]),
    ],
  ];
  if (config.modelSelection?.tier) {
    entries.splice(2, 0,
      ["tier", describeModel(config), "active"],
      ["reasoningEffort", config.modelSelection.reasoningEffort ?? "provider default", "active"],
      ["context.inputLimit", String(config.modelSelection.inputLimit), "active"]);
  }

  const nameWidth = Math.max(...entries.map(([name]) => name.length));
  const valueWidth = Math.max(...entries.map(([, value]) => value.length));

  const lines = [
    `Mode: ${mode} (${modeSourceLabel[modeSource] ?? modeSource})`,
    `Context usage (estimated): ${contextTokens} / ${window} tokens (${contextPercent}%)`,
  ];
  for (const [name, value, source] of entries) {
    lines.push(`  ${name.padEnd(nameWidth)}  ${value.padEnd(valueWidth)}  ${source}`);
  }

  lines.push(
    `Settings file: ${config.settingsFile ?? "none (built-in defaults)"}`,
  );
  for (const warning of config.settingsWarnings) {
    lines.push(`Warning: ${warning}`);
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
