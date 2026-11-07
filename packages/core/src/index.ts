import type { Tool } from "./tools/tool.js";
import { fileTools } from "./tools/fs.js";
import { runCommandTool } from "./tools/shell.js";

export * from "./types.js";
export * from "./agent.js";
export * from "./provider/types.js";
export * from "./provider/openai-compatible.js";
export * from "./tools/tool.js";
export * from "./tools/paths.js";
export * from "./tools/fs.js";
export * from "./tools/shell.js";
export * from "./context/estimator.js";
export * from "./context/groups.js";
export * from "./context/prune.js";
export * from "./context/summarize.js";
export * from "./context/budget.js";
export * from "./context/window.js";
export * from "./instructions.js";

/** Every built-in tool: file inspection/editing plus shell execution. */
export const allTools: Tool[] = [...fileTools, runCommandTool];
