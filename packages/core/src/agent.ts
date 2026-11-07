import type { Message, ToolCall } from "./types.js";
import type { Provider } from "./provider/types.js";
import {
  toToolSpec,
  type Tool,
  type ToolContext,
  type ToolResult,
} from "./tools/tool.js";

export type ApprovalRequest = {
  call: ToolCall;
  toolName: string;
  /** Human-readable description produced by the tool's summarize(). */
  summary: string;
  /** Parsed and schema-validated tool input. */
  input: unknown;
};

export type ApprovalDecision = "allow" | "deny";

export type AgentEvent =
  | { type: "turn-start"; turn: number }
  | { type: "text-delta"; delta: string }
  | { type: "assistant-done"; content: string; toolCalls: ToolCall[] }
  | { type: "tool-start"; call: ToolCall; summary: string }
  | {
      type: "tool-end";
      call: ToolCall;
      summary: string;
      result: ToolResult;
      isError: boolean;
      denied: boolean;
      durationMs: number;
    }
  | { type: "max-turns"; turns: number };

export type RunAgentOptions = {
  provider: Provider;
  model: string;
  tools: Tool[];
  /** Conversation history, appended to in place. The caller owns it across turns. */
  messages: Message[];
  context: ToolContext;
  maxTurns?: number;
  signal?: AbortSignal;
  /**
   * Called before executing a tool with requiresApproval. Returning "deny"
   * feeds a denial result back to the model instead of running the tool.
   * When omitted, approval-gated tools run without asking.
   */
  approve?: (
    request: ApprovalRequest,
  ) => Promise<ApprovalDecision> | ApprovalDecision;
};

const DENIED_MESSAGE =
  "Permission denied by the user. The tool was not executed. Do not retry the same call; explain what you wanted to do and ask how to proceed.";

function summarize(tool: Tool, input: unknown, call: ToolCall): string {
  try {
    return tool.summarize?.(input) ?? call.arguments;
  } catch {
    return call.arguments;
  }
}

async function executeTool(
  tool: Tool,
  input: unknown,
  context: ToolContext,
): Promise<ToolResult> {
  try {
    return await tool.execute(input, context);
  } catch (error) {
    return {
      content: `Error: ${error instanceof Error ? error.message : String(error)}`,
      isError: true,
    };
  }
}

/**
 * The UI-independent agent loop: stream a model response, execute any tool
 * calls, feed results back, repeat until the model answers without tools.
 *
 * Emits events instead of writing to stdout so every surface (TUI, desktop,
 * server) can render it independently.
 */
export async function* runAgent(
  options: RunAgentOptions,
): AsyncGenerator<AgentEvent, void, void> {
  const { provider, model, tools, messages, context } = options;
  const maxTurns = options.maxTurns ?? 25;
  const specs = tools.map(toToolSpec);
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));

  for (let turn = 1; turn <= maxTurns; turn += 1) {
    yield { type: "turn-start", turn };

    let content = "";
    let toolCalls: ToolCall[] = [];

    for await (const event of provider.stream({
      model,
      messages,
      tools: specs,
      signal: options.signal,
    })) {
      if (event.type === "text") {
        content += event.delta;
        yield { type: "text-delta", delta: event.delta };
      } else if (event.type === "done") {
        content = event.message.content;
        toolCalls = event.message.toolCalls;
      }
    }

    messages.push(
      toolCalls.length > 0
        ? { role: "assistant", content, toolCalls }
        : { role: "assistant", content },
    );
    yield { type: "assistant-done", content, toolCalls };

    if (toolCalls.length === 0) return;

    for (const call of toolCalls) {
      const tool = toolsByName.get(call.name);

      let input: unknown;
      let invalid: Error | null = null;

      if (!tool) {
        invalid = new Error(`Unknown tool: ${call.name}`);
      } else {
        try {
          const rawInput = call.arguments.trim()
            ? JSON.parse(call.arguments)
            : {};
          input = tool.inputSchema.parse(rawInput);
        } catch (error) {
          invalid = error instanceof Error ? error : new Error(String(error));
        }
      }

      const summary =
        tool && !invalid ? summarize(tool, input, call) : call.arguments;
      yield { type: "tool-start", call, summary };
      const startedAt = Date.now();

      let result: ToolResult;
      let denied = false;

      if (!tool || invalid) {
        result = {
          content: `Error: ${invalid?.message ?? "Unknown tool"}`,
          isError: true,
        };
      } else if (tool.requiresApproval && options.approve) {
        let decision: ApprovalDecision = "deny";
        try {
          decision = await options.approve({
            call,
            toolName: tool.name,
            summary,
            input,
          });
        } catch {
          decision = "deny";
        }

        if (decision === "allow") {
          result = await executeTool(tool, input, context);
        } else {
          denied = true;
          result = { content: DENIED_MESSAGE, isError: true };
        }
      } else {
        result = await executeTool(tool, input, context);
      }

      const durationMs = Date.now() - startedAt;
      messages.push({
        role: "tool",
        toolCallId: call.id,
        content: result.content,
      });
      yield {
        type: "tool-end",
        call,
        summary,
        result,
        isError: result.isError === true,
        denied,
        durationMs,
      };
    }
  }

  yield { type: "max-turns", turns: maxTurns };
}
