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

/**
 * A side-effect-free description of what a call will do, shown to the user
 * before they approve it. Carrying the before/after text (rather than a
 * pre-rendered diff) keeps the rendering decision in the host.
 */
export type ToolPreview =
  | { kind: "diff"; path: string; before: string; after: string }
  | { kind: "text"; title: string; text: string };

export type Tool<S extends z.ZodType = z.ZodType> = {
  name: string;
  description: string;
  inputSchema: S;
  /** If true, the host asks the user for permission before execution. */
  requiresApproval?: boolean;
  /** Short, human-readable description of a call, shown in approvals and the UI. */
  summarize?(input: z.infer<S>): string;
  /**
   * Optional preview of the effect. Must not modify anything, and may return
   * undefined when a preview would be misleading or too expensive.
   */
  preview?(
    input: z.infer<S>,
    ctx: ToolContext,
  ): Promise<ToolPreview | undefined> | ToolPreview | undefined;
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
