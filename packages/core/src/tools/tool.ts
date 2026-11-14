import { z } from "zod";
import type { ToolCapability } from "../permissions.js";
import type { ToolSpec } from "../types.js";

export type ToolContext = {
  /** Absolute path of the workspace the tools are allowed to touch. */
  root: string;
  /** Aborts in-flight work when the user interrupts or the host shuts down. */
  signal?: AbortSignal;
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
  | {
      kind: "diff";
      path: string;
      before: string;
      after: string;
      createsFile?: boolean;
      /** Checks that the effect shown is still current before execution. */
      revalidate?: () => Promise<boolean>;
    }
  | {
      kind: "command";
      shell: string;
      executable: string;
      cwd: string;
      command: string;
      /** Checks that the working directory still resolves to the previewed path. */
      revalidate?: () => Promise<boolean>;
    }
  | { kind: "text"; title: string; text: string }
  | { kind: "unavailable"; reason: string }
  | { kind: "invalid"; reason: string };

export type Tool<S extends z.ZodType = z.ZodType> = {
  name: string;
  description: string;
  inputSchema: S;
  /**
   * Raw JSON Schema for tools whose schema comes from outside (MCP). When
   * present, it is sent to the model verbatim instead of deriving one from
   * `inputSchema`; `inputSchema` is then a permissive parser and the external
   * server performs authoritative validation.
   */
  jsonSchema?: Record<string, unknown>;
  /**
   * What the tool is allowed to do. Tools that include "write", "execute", or
   * "network" are approval-gated; read-only tools run without asking. The permission
   * policy treats missing capabilities as dangerous (fail closed).
   */
  capabilities: readonly ToolCapability[];
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
  /** The approved preview, when present, belongs to this invocation only. */
  execute(input: z.infer<S>, ctx: ToolContext, approvedPreview?: ToolPreview): Promise<ToolResult>;
};

export function toToolSpec<S extends z.ZodType>(tool: Tool<S>): ToolSpec {
  const schema: Record<string, unknown> = tool.jsonSchema
    ? { ...tool.jsonSchema }
    : (z.toJSONSchema(tool.inputSchema) as Record<string, unknown>);
  // Some providers reject unknown top-level keywords. Clone first so a raw
  // schema shared with an external server is never mutated.
  delete schema.$schema;
  return {
    name: tool.name,
    description: tool.description,
    parameters: schema,
  };
}
