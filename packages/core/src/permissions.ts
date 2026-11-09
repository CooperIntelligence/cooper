/**
 * Permission decisions, independent of any UI.
 *
 * Two axes:
 *   - preset: plan | ask | auto
 *   - outcome: allow once | allow for this process | deny
 *
 * The policy is fail-closed. It returns "prompt" only when the surface can
 * actually ask; the agent loop denies anything it cannot get an explicit
 * answer for. Plan mode never prompts, so a host cannot silently downgrade it
 * to "ask" (AGENTS.md rules 8 and 10).
 */

export type ToolCapability = "read" | "write" | "execute";

export type PermissionPreset = "plan" | "ask" | "auto";

export type PermissionDecision = "allow" | "prompt" | "deny";

export type ApprovalOutcome = "allow" | "allow-session" | "deny";

export type PermissionPolicyOptions = {
  preset: PermissionPreset;
  /** True only when the surface has a human who can answer an approval. */
  interactive: boolean;
};

/**
 * A tool with no declared capabilities is treated as dangerous. New tools are
 * forced by the type system to declare at least one capability; this fallback
 * covers tools from external sources (future MCP servers) that omit metadata.
 */
export function needsApproval(
  capabilities: readonly ToolCapability[] | undefined,
): boolean {
  if (capabilities === undefined || capabilities.length === 0) return true;
  return capabilities.some((capability) => capability !== "read");
}

export class PermissionPolicy {
  private currentPreset: PermissionPreset;
  readonly interactive: boolean;

  /** Tools the user allowed for the rest of this process (never persisted). */
  private readonly sessionAllowed = new Set<string>();

  constructor(options: PermissionPolicyOptions) {
    this.currentPreset = options.preset;
    this.interactive = options.interactive;
  }

  get preset(): PermissionPreset {
    return this.currentPreset;
  }

  /**
   * Switches the mode for the rest of this process. Callers must only do this
   * while the agent is idle; session grants are intentionally preserved.
   */
  setPreset(next: PermissionPreset): void {
    this.currentPreset = next;
  }

  decide(tool: {
    name: string;
    capabilities?: readonly ToolCapability[];
  }): PermissionDecision {
    // auto is an explicit, auditable opt-in to run everything.
    if (this.preset === "auto") return "allow";

    // Read-only tools never need permission in any preset.
    if (!needsApproval(tool.capabilities)) return "allow";

    // Plan is read-only. Check it before session grants so switching presets
    // can never turn a previous "always allow" into a mutation.
    if (this.preset === "plan") return "deny";

    if (this.sessionAllowed.has(tool.name)) return "allow";

    // ask with nobody to ask is indistinguishable from a denial.
    return this.interactive ? "prompt" : "deny";
  }

  /** Remember an "always allow this tool" decision for this process only. */
  grantSession(toolName: string): void {
    this.sessionAllowed.add(toolName);
  }

  isSessionAllowed(toolName: string): boolean {
    return this.sessionAllowed.has(toolName);
  }
}
