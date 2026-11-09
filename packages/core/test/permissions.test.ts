import { describe, expect, it } from "vitest";
import {
  PermissionPolicy,
  needsApproval,
  type PermissionPreset,
} from "../src/permissions.js";

const read = { name: "read_file", capabilities: ["read"] as const };
const write = { name: "write_file", capabilities: ["write"] as const };
const execute = { name: "run_command", capabilities: ["execute"] as const };

function policy(preset: PermissionPreset, interactive: boolean) {
  return new PermissionPolicy({ preset, interactive });
}

describe("needsApproval", () => {
  it("gates anything that is not purely read-only", () => {
    expect(needsApproval(["read"])).toBe(false);
    expect(needsApproval(["read", "write"])).toBe(true);
    expect(needsApproval(["write"])).toBe(true);
    expect(needsApproval(["execute"])).toBe(true);
  });

  it("treats missing capabilities as dangerous", () => {
    expect(needsApproval(undefined)).toBe(true);
    expect(needsApproval([])).toBe(true);
  });
});

describe("PermissionPolicy", () => {
  it("always allows read-only tools", () => {
    for (const preset of ["plan", "ask", "auto"] as const) {
      for (const interactive of [true, false]) {
        expect(policy(preset, interactive).decide(read)).toBe("allow");
      }
    }
  });

  it("denies writes and commands in plan mode without prompting", () => {
    const permissions = policy("plan", true);
    expect(permissions.decide(write)).toBe("deny");
    expect(permissions.decide(execute)).toBe("deny");

    // A session grant must never turn plan into a mutating mode.
    permissions.grantSession("write_file");
    expect(permissions.decide(write)).toBe("deny");
  });

  it("prompts for writes and commands in interactive ask mode", () => {
    const permissions = policy("ask", true);
    expect(permissions.decide(write)).toBe("prompt");
    expect(permissions.decide(execute)).toBe("prompt");
  });

  it("denies writes and commands when nobody can be asked", () => {
    const permissions = policy("ask", false);
    expect(permissions.decide(write)).toBe("deny");
    expect(permissions.decide(execute)).toBe("deny");
  });

  it("allows writes and commands in auto mode", () => {
    const permissions = policy("auto", false);
    expect(permissions.decide(write)).toBe("allow");
    expect(permissions.decide(execute)).toBe("allow");
  });

  it("grants a tool for the session by name", () => {
    const permissions = policy("ask", true);
    permissions.grantSession("write_file");

    expect(permissions.isSessionAllowed("write_file")).toBe(true);
    expect(permissions.decide(write)).toBe("allow");
    // The grant is per tool, not per capability.
    expect(permissions.decide({ name: "edit_file", capabilities: ["write"] })).toBe(
      "prompt",
    );
  });

  it("fails closed for tools without capabilities", () => {
    expect(policy("ask", true).decide({ name: "mystery" })).toBe("prompt");
    expect(policy("ask", false).decide({ name: "mystery" })).toBe("deny");
    expect(policy("plan", true).decide({ name: "mystery" })).toBe("deny");
  });

  it("switches modes at runtime and keeps session grants", () => {
    const permissions = policy("ask", true);
    permissions.grantSession("write_file");

    expect(permissions.decide(write)).toBe("allow");

    permissions.setPreset("plan");
    expect(permissions.preset).toBe("plan");
    expect(permissions.decide(write)).toBe("deny");

    // The process-level grant survives a temporary read-only mode.
    permissions.setPreset("ask");
    expect(permissions.decide(write)).toBe("allow");

    permissions.setPreset("auto");
    expect(permissions.decide(execute)).toBe("allow");
  });
});
