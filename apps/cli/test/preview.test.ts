import { describe, expect, it } from "vitest";
import { buildPreviewRows } from "../src/preview.js";

describe("buildPreviewRows", () => {
  it("renders a hunk header and marked lines", () => {
    const preview = buildPreviewRows({
      before: "a\nb\nc\n",
      after: "a\nB\nc\n",
    });

    expect(preview.added).toBe(1);
    expect(preview.removed).toBe(1);
    expect(preview.hidden).toBe(0);

    const texts = preview.rows.map((row) => row.text);
    expect(texts[0]).toMatch(/^@@ -\d+,\d+ \+\d+,\d+ @@$/);
    expect(texts).toContain("-b");
    expect(texts).toContain("+B");
    expect(texts).toContain(" a");

    expect(preview.rows.find((row) => row.text === "-b")?.tone).toBe("remove");
    expect(preview.rows.find((row) => row.text === "+B")?.tone).toBe("add");
  });

  it("reports no rows when nothing changes", () => {
    const preview = buildPreviewRows({ before: "same\n", after: "same\n" });
    expect(preview.rows).toEqual([]);
    expect(preview.hidden).toBe(0);
    expect(preview.added).toBe(0);
    expect(preview.removed).toBe(0);
  });

  it("caps the rows and counts the rest", () => {
    const before = Array.from({ length: 100 }, (_, i) => `old ${i}`).join("\n");
    const after = Array.from({ length: 100 }, (_, i) => `new ${i}`).join("\n");

    const preview = buildPreviewRows({ before, after }, 10);

    expect(preview.rows).toHaveLength(10);
    expect(preview.hidden).toBeGreaterThan(0);
  });

  it("truncates very long lines", () => {
    const long = "x".repeat(500);
    const preview = buildPreviewRows({ before: "", after: long });

    const added = preview.rows.find((row) => row.tone === "add");
    expect(added?.text.length).toBeLessThanOrEqual(202);
    expect(added?.text.endsWith("…")).toBe(true);
  });
});
