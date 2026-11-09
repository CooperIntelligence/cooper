import type { ApprovalMode } from "./config.js";

export type CommandName = ApprovalMode | "help";

export type ParsedCommand =
  | { kind: "prompt"; text: string }
  | { kind: "command"; name: CommandName; args: string }
  | { kind: "unknown"; name: string };

const COMMANDS = new Set<string>(["help", "plan", "ask", "auto"]);

/** Parses the TUI's slash-command prefix. Anything else is a model prompt. */
export function parseCommand(input: string): ParsedCommand {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return { kind: "prompt", text: input };

  const match = /^([^\s]*)(?:\s+([\s\S]*))?$/.exec(trimmed.slice(1));
  const name = (match?.[1] ?? "").toLowerCase();
  const args = (match?.[2] ?? "").trim();
  if (!COMMANDS.has(name)) return { kind: "unknown", name };
  return { kind: "command", name: name as CommandName, args };
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
  return [
    `Commands · current mode: ${modeDescription(mode)}`,
    "/help   show this help",
    "/plan   read-only planning mode",
    "/ask    approve writes and commands",
    "/auto   auto-approve ALL tools",
  ].join("\n");
}
