import { BUILTIN_COMMANDS, type CommandSpec } from "@cooper/host/commands";

const desktopCommandNames = ["help", "plan", "ask", "auto", "clear", "sessions", "resume", "status", "config"] as const;
export type DesktopCommandName = (typeof desktopCommandNames)[number];
type BuiltinCommand = (typeof BUILTIN_COMMANDS)[number];

function supportsCommand(spec: BuiltinCommand): spec is Extract<BuiltinCommand, { name: DesktopCommandName }> {
  return desktopCommandNames.some((name) => name === spec.name);
}

export const DESKTOP_COMMANDS: readonly CommandSpec<DesktopCommandName>[] = BUILTIN_COMMANDS.filter(supportsCommand).map((spec) => {
  switch (spec.name) {
    case "help":
      return { ...spec, description: "show available commands" };
    case "sessions":
      return { ...spec, description: "open the conversations sidebar" };
    case "status":
      return { ...spec, description: "show the current workspace, conversation, model, and mode" };
    case "config":
      return { ...spec, usage: "/config", description: "open model settings" };
    default:
      return spec;
  }
});
