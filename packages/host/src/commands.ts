export type CommandSpec<Name extends string = string> = {
  name: Name;
  aliases: readonly string[];
  usage: string;
  description: string;
};

export const BUILTIN_COMMANDS = [
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
    description: "approve writes, commands, and web requests",
  },
  {
    name: "auto",
    aliases: [],
    usage: "/auto",
    description: "use automatic approval rules and require a sandbox for shell",
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
    name: "skill",
    aliases: [],
    usage: "/skill <name> [request]",
    description: "use a skill for this request",
  },
  {
    name: "skills",
    aliases: [],
    usage: "/skills",
    description: "list discovered skills",
  },
  {
    name: "status",
    aliases: [],
    usage: "/status",
    description: "show effective settings and where each value came from",
  },
  {
    name: "config",
    aliases: [],
    usage: "/config [setting]",
    description: "edit and apply user configuration",
  },
  {
    name: "reload",
    aliases: [],
    usage: "/reload",
    description: "apply edits to ~/.cooper/config.json",
  },
  {
    name: "exit",
    aliases: [],
    usage: "/exit",
    description: "quit the TUI",
  },
] as const satisfies readonly CommandSpec[];

export type BuiltinCommandName = (typeof BUILTIN_COMMANDS)[number]["name"];

export type ParsedCommand<Name extends string> =
  | { kind: "prompt"; text: string }
  | { kind: "command"; name: Name; args: string }
  | { kind: "unknown"; name: string };

export function isSlashInput(input: string): boolean {
  return input.trimStart().startsWith("/");
}

export function parseCommand<Name extends string>(
  input: string,
  commands: readonly CommandSpec<Name>[],
): ParsedCommand<Name> {
  if (!isSlashInput(input)) return { kind: "prompt", text: input };

  const match = /^([^\s]*)(?:\s+([\s\S]*))?$/.exec(input.trim().slice(1));
  const rawName = (match?.[1] ?? "").toLowerCase();
  const spec = commands.find(({ name, aliases }) => name === rawName || aliases.includes(rawName));
  if (!spec) return { kind: "unknown", name: rawName };
  return { kind: "command", name: spec.name, args: (match?.[2] ?? "").trim() };
}

export function filterCommands<Name extends string>(
  input: string,
  commands: readonly CommandSpec<Name>[],
): CommandSpec<Name>[] {
  if (!isSlashInput(input)) return [];
  const token = (/^\S*/.exec(input.trimStart().slice(1))?.[0] ?? "").toLowerCase();
  return commands.filter(
    ({ name, aliases }) => name.startsWith(token) || aliases.some((alias) => alias.startsWith(token)),
  );
}

/** Text after the first slash token, e.g. `/resume abc` → `abc`. */
export function commandArgsOf(input: string): string {
  const match = /^\/\S*(?:\s+([\s\S]*))?$/.exec(input.trim());
  return (match?.[1] ?? "").trim();
}

/** Canonical invocation for a spec, preserving any typed args. */
export function completeCommand(input: string, spec: CommandSpec): string {
  const args = commandArgsOf(input);
  const base = `/${spec.name}`;
  if (args.length > 0) return `${base} ${args}`;
  // Placeholders like `/resume <id>` get a trailing space for the argument.
  return spec.usage.includes("<") ? `${base} ` : base;
}
