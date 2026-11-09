import { describe, expect, it } from "vitest";
import {
  isRuntimeNotice,
  permissionModeNotice,
} from "../src/runtime-notice.js";

describe("permissionModeNotice", () => {
  it("marks a deterministic user-role notice for each mode", () => {
    for (const preset of ["plan", "ask", "auto"] as const) {
      const first = permissionModeNotice(preset);
      const second = permissionModeNotice(preset);

      expect(first).toEqual(second);
      expect(first.role).toBe("user");
      if (first.role !== "user") throw new Error("unreachable");
      expect(first.runtime).toBe("permission-mode");
      expect(first.content).toContain(`<cooper-runtime mode="${preset}">`);
      expect(first.content).toContain("This supersedes earlier runtime notices.");
    }
  });

  it("carries the mode-specific behavioral guidance", () => {
    const plan = permissionModeNotice("plan");
    const ask = permissionModeNotice("ask");
    const auto = permissionModeNotice("auto");
    if (plan.role !== "user" || ask.role !== "user" || auto.role !== "user") {
      throw new Error("unreachable");
    }

    expect(plan.content).toContain("read-only");
    expect(plan.content).toContain("wait for the user");
    expect(ask.content).toContain("require user approval");
    expect(auto.content).toContain("auto-approved");
  });
});

describe("isRuntimeNotice", () => {
  it("recognizes only host-authored runtime messages", () => {
    expect(isRuntimeNotice(permissionModeNotice("plan"))).toBe(true);
    expect(isRuntimeNotice({ role: "user", content: "hello" })).toBe(false);
    expect(isRuntimeNotice({ role: "assistant", content: "hello" })).toBe(false);
    expect(isRuntimeNotice({ role: "system", content: "hello" })).toBe(false);
    expect(
      isRuntimeNotice({ role: "tool", toolCallId: "1", content: "hello" }),
    ).toBe(false);
  });
});
