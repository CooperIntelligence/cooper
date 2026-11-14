import type { Tool } from "./tools/tool.js";
import { fileTools } from "./tools/fs.js";
import { createRunCommandTool, runCommandTool, type CommandShell } from "./tools/shell.js";
import { webFetchTool } from "./tools/web-fetch.js";

export * from "./types.js";
export * from "./agent.js";
export * from "./permissions.js";
export * from "./runtime-notice.js";
export * from "./provider/types.js";
export * from "./provider/openai-compatible.js";
export * from "./provider/openai-responses.js";
export * from "./provider/anthropic.js";
export * from "./tools/tool.js";
export * from "./tools/paths.js";
export * from "./tools/fs.js";
export * from "./tools/shell.js";
export * from "./tools/skill.js";
export * from "./tools/web-fetch.js";
export * from "./tools/web-search.js";
export * from "./context/estimator.js";
export * from "./context/groups.js";
export * from "./context/prune.js";
export * from "./context/summarize.js";
export * from "./context/budget.js";
export * from "./context/window.js";
export * from "./home.js";
export * from "./instructions.js";
export * from "./skills.js";
export * from "./session.js";
export * from "./mcp/config.js";
export * from "./mcp/resources.js";
export * from "./mcp/tool.js";
export * from "./mcp/client.js";
export * from "./diff.js";

/** Tools available without optional service credentials. */
export const allTools: Tool[] = [...fileTools, runCommandTool, webFetchTool];

export function createBuiltinTools(shell: CommandShell): Tool[] {
  return [...fileTools, createRunCommandTool(shell), webFetchTool];
}
