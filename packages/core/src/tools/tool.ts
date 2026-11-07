import { z } from "zod";
import type { ToolSpec } from "../types.js";

export type ToolContext = {
  /** Absolute path of the workspace the tools are allowed to touch. */
  root: string;
};

export type ToolResult = {
  content: string;
  isError?: boolean;
};

export type Tool<S extends z.ZodType = z.ZodType> = {
  name: string;
  description: string;
  inputSchema: S;
  /** If true, the host asks the user for permission before execution. */
  requiresApproval?: boolean;
  /** Short, human-readable description of a call, shown in approvals and the UI. */
  summarize?(input: z.infer<S>): string;
  execute(input: z.infer<S>, ctx: ToolContext): Promise<ToolResult>;
};

export function toToolSpec<S extends z.ZodType>(tool: Tool<S>): ToolSpec {
  const schema = z.toJSONSchema(tool.inputSchema) as Record<string, unknown>;
  // Some OpenAI-compatible providers reject unknown top-level keywords.
  delete schema.$schema;
  return {
    name: tool.name,
    description: tool.description,
    parameters: schema,
  };
}
