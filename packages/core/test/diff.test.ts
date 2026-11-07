import { describe, expect, it } from "vitest";
import { diffText } from "../src/diff.js";

describe("diffText", () => {
  it("reports no hunks for identical text", () => {
    const result = diffText("a\nb\n", "a\nb\n");
    expect(result.hunks).toEqual([]);
    expect(result.added).toBe(0);
    expect(result.removed).toBe(0);
  });

  it("shows a replacement with surrounding context", () => {
    const result = diffText(
      "a\nb\nc\nd\ne\nf\ng\nh\n",
      "a\nb\nc\nD\ne\nf\ng\nh\n",
    );

    expect(result.added).toBe(1);
    expect(result.removed).toBe(1);
    expect(result.hunks).toHaveLength(1);

    const hunk = result.hunks[0];
    expect(hunk?.oldStart).toBe(1);
    expect(hunk?.oldCount).toBe(7);
    expect(hunk?.newCount).toBe(7);
    expect(hunk?.lines.find((line) => line.kind === "remove")?.text).toBe("d");
    expect(hunk?.lines.find((line) => line.kind === "add")?.text).toBe("D");
    expect(hunk?.lines.find((line) => line.kind === "add")?.newLine).toBe(4);
  });

  it("treats a new file as pure additions", () => {
    const result = diffText("", "x\ny\n");
    expect(result.added).toBe(2);
    expect(result.removed).toBe(0);

    const hunk = result.hunks[0];
    expect(hunk?.oldStart).toBe(0);
    expect(hunk?.oldCount).toBe(0);
    expect(hunk?.newStart).toBe(1);
    expect(hunk?.newCount).toBe(2);
  });

  it("handles deletions", () => {
    const result = diffText("a\nb\nc\n", "a\nc\n");
    expect(result.added).toBe(0);
    expect(result.removed).toBe(1);
    expect(result.hunks[0]?.lines.some((line) => line.kind === "remove")).toBe(
      true,
    );
  });

  it("keeps a distant change small instead of echoing the file", () => {
    const before = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`);
    const after = [...before];
    after[99] = "changed";

    const result = diffText(before.join("\n"), after.join("\n"));

    expect(result.hunks).toHaveLength(1);
    // 3 context lines, the removed line, the added line, 3 context lines.
    expect(result.hunks[0]?.lines.length).toBe(8);
    expect(result.added).toBe(1);
    expect(result.removed).toBe(1);
  });

  it("normalizes CRLF line endings", () => {
    const result = diffText("a\r\nb\r\n", "a\r\nB\r\n");
    expect(result.added).toBe(1);
    expect(result.removed).toBe(1);
    expect(result.hunks[0]?.lines.find((line) => line.kind === "add")?.text).toBe(
      "B",
    );
  });

  it("coarsens very large rewrites instead of aligning them", () => {
    const before = Array.from({ length: 2000 }, (_, i) => `old ${i}`);
    const after = Array.from({ length: 2000 }, (_, i) => `new ${i}`);

    const result = diffText(before.join("\n"), after.join("\n"));

    expect(result.coarsened).toBe(true);
    expect(result.added).toBe(2000);
    expect(result.removed).toBe(2000);
  });
});
