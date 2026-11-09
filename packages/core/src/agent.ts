import type { Message, ProviderData, ToolCall } from "./types.js";
import type { Provider, TokenUsage } from "./provider/types.js";
import {
  DEFAULT_CONTEXT_CONFIG,
  estimateContextTokens,
  prepareContext,
  resolveContextConfig,
  type ContextAction,
  type ContextSettings,
} from "./context/budget.js";
import {
  INITIAL_CALIBRATION,
  updateCalibration,
  type Calibration,
} from "./context/estimator.js";
import {
  toToolSpec,
  type Tool,
  type ToolContext,
  type ToolPreview,
  type ToolResult,
} from "./tools/tool.js";
import type {
  ApprovalOutcome,
  PermissionPolicy,
  ToolCapability,
} from "./permissions.js";

export type ApprovalRequest = {
  call: ToolCall;
  toolName: string;
  /** Human-readable description produced by the tool's summarize(). */
  summary: string;
  /** Parsed and schema-validated tool input. */
  input: unknown;
  /** What the tool is allowed to do (read / write / execute). */
  capabilities: readonly ToolCapability[];
  /**
   * Side-effect-free preview of the effect (a file diff for edits). Undefined
   * for tools without a preview or when one cannot be produced.
   */
  preview?: ToolPreview;
};

export type AgentEvent =
  | { type: "turn-start"; turn: number }
  | { type: "text-delta"; delta: string }
  /** Ephemeral reasoning summary. Never added to `messages`. */
  | { type: "reasoning-delta"; delta: string }
  | {
      type: "assistant-done";
      content: string;
      toolCalls: ToolCall[];
      usage?: TokenUsage;
      /** Opaque provider data that must be replayed to the same provider. */
      providerData?: ProviderData;
    }
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
  | {
      type: "context-compacted";
      action: ContextAction["action"];
      /** Estimated tokens in the conversation before and after compaction. */
      before: number;
      after: number;
    }
  | { type: "max-turns"; turns: number };

export type RunAgentOptions = {
  provider: Provider;
  model: string;
  tools: Tool[];
  /** Conversation history, appended to in place. The caller owns it across turns. */
  messages: Message[];
  context: ToolContext;
  /**
   * Required: every surface must state its policy explicitly. The policy is
   * fail-closed, so forgetting an approver denies gated tools instead of
   * running them unattended.
   */
  permissions: PermissionPolicy;
  maxTurns?: number;
  signal?: AbortSignal;
  /**
   * Context budgeting for the conversation. Defaults to a 200k window; pass
   * `false` to send history untouched (tests, or a host with its own policy).
   */
  contextBudget?: ContextSettings | false;
  /**
   * Called only when the permission policy returns "prompt". Returning
   * "deny" feeds a denial result back to the model instead of running the
   * tool; "allow-session" grants the tool for the rest of this process.
   * When omitted, prompted tools are denied (fail closed).
   */
  approve?: (
    request: ApprovalRequest,
  ) => Promise<ApprovalOutcome> | ApprovalOutcome;
};

const NO_RETRY =
  "Do not retry the same call; explain what you wanted to do and ask how to proceed.";

const USER_DENIED_MESSAGE =
  `Permission denied by the user. The tool was not executed. ${NO_RETRY}`;

const NO_APPROVER_MESSAGE =
  `Permission denied: this run has no interactive approver, so the tool was not executed. ${NO_RETRY}`;

function policyDeniedMessage(policy: PermissionPolicy): string {
  if (policy.preset === "plan") {
    return (
      "Permission denied: plan mode is read-only, so tools that change the " +
      `workspace or execute commands are not allowed. ${NO_RETRY}`
    );
  }
  return NO_APPROVER_MESSAGE;
}

const CONTEXT_ERROR_PATTERN =
  /context.{0,24}(length|window)|maximum context|prompt is too long|reduce the length|too many tokens|exceeds the maximum/i;

function isContextLengthError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return CONTEXT_ERROR_PATTERN.test(message);
}

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
  // Tools that can block (MCP, long commands) need the same abort signal as
  // the provider stream so Ctrl+C cancels them too.
  const toolContext: ToolContext = {
    ...context,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  };
  const maxTurns = options.maxTurns ?? 25;
  const specs = tools.map(toToolSpec);
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));

  const contextConfig =
    options.contextBudget === false
      ? null
      : resolveContextConfig(
          options.contextBudget ?? { window: DEFAULT_CONTEXT_CONFIG.window },
        );
  let calibration: Calibration = INITIAL_CALIBRATION;

  const compact = (force: boolean, budgetOverride?: number) =>
    prepareContext({
      messages,
      tools: specs,
      provider,
      model,
      config: contextConfig ?? DEFAULT_CONTEXT_CONFIG,
      calibration,
      signal: options.signal,
      force,
      budgetOverride,
    });

  for (let turn = 1; turn <= maxTurns; turn += 1) {
    yield { type: "turn-start", turn };

    if (contextConfig) {
      for (const action of await compact(false)) {
        yield { type: "context-compacted", ...action };
      }
    }

    let content = "";
    let toolCalls: ToolCall[] = [];
    let usage: TokenUsage | undefined;
    let providerData: ProviderData | undefined;
    let emittedText = false;
    let retried = false;

    for (;;) {
      content = "";
      toolCalls = [];
      usage = undefined;
      providerData = undefined;
      emittedText = false;

      const estimated = estimateContextTokens(messages, specs, calibration);

      try {
        for await (const event of provider.stream({
          model,
          messages,
          tools: specs,
          signal: options.signal,
        })) {
          if (event.type === "text") {
            emittedText = true;
            content += event.delta;
            yield { type: "text-delta", delta: event.delta };
          } else if (event.type === "reasoning") {
            yield { type: "reasoning-delta", delta: event.delta };
          } else if (event.type === "done") {
            content = event.message.content;
            toolCalls = event.message.toolCalls;
            usage = event.usage;
            providerData = event.message.providerData;
            if (event.usage?.inputTokens) {
              calibration = updateCalibration(
                calibration,
                event.usage.inputTokens,
                estimated,
              );
            }
          }
        }
        break;
      } catch (error) {
        // The window we assumed may be larger than the real one. Compact hard
        // and retry once; only safe before any text reached the user.
        if (
          !retried &&
          !emittedText &&
          contextConfig &&
          isContextLengthError(error)
        ) {
          retried = true;
          // The rejected request was `estimated` tokens, so the real window is
          // smaller than that. Compact to half of it and try again.
          const actions = await compact(
            true,
            Math.max(2048, Math.floor(estimated / 2)),
          );
          if (actions.length === 0) throw error;
          for (const action of actions) {
            yield { type: "context-compacted", ...action };
          }
          continue;
        }
        throw error;
      }
    }

    messages.push(
      toolCalls.length > 0
        ? {
            role: "assistant",
            content,
            toolCalls,
            ...(providerData !== undefined ? { providerData } : {}),
          }
        : {
            role: "assistant",
            content,
            ...(providerData !== undefined ? { providerData } : {}),
          },
    );
    yield {
      type: "assistant-done",
      content,
      toolCalls,
      usage,
      ...(providerData !== undefined ? { providerData } : {}),
    };

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
      } else {
        const decision = options.permissions.decide(tool);

        if (decision === "deny") {
          denied = true;
          result = {
            content: policyDeniedMessage(options.permissions),
            isError: true,
          };
        } else if (decision === "allow") {
          result = await executeTool(tool, input, toolContext);
        } else {
          let preview: ToolPreview | undefined;
          if (tool.preview) {
            try {
              preview = await tool.preview(input, toolContext);
            } catch {
              // A preview must never block the call; approval still happens.
              preview = undefined;
            }
          }

          let outcome: ApprovalOutcome | null = null;
          if (options.approve) {
            try {
              outcome = await options.approve({
                call,
                toolName: tool.name,
                summary,
                input,
                capabilities: tool.capabilities,
                preview,
              });
            } catch {
              outcome = "deny";
            }
          }

          if (outcome === null) {
            denied = true;
            result = { content: NO_APPROVER_MESSAGE, isError: true };
          } else if (outcome === "allow" || outcome === "allow-session") {
            if (outcome === "allow-session") {
              options.permissions.grantSession(tool.name);
            }
            result = await executeTool(tool, input, toolContext);
          } else {
            denied = true;
            result = { content: USER_DENIED_MESSAGE, isError: true };
          }
        }
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
