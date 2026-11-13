import { describe, expect, it } from "vitest";
import { buildPreviewRows, wrapPreviewText } from "../src/preview.js";

describe("buildPreviewRows", () => {
  it("renders a hunk header and marked lines", () => {
    const preview = buildPreviewRows({
      before: "a\nb\nc\n",
      after: "a\nB\nc\n",
    });

    expect(preview.added).toBe(1);
    expect(preview.removed).toBe(1);

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
    expect(preview.rows).toEqual([{ text: "No changes.", tone: "context" }]);
    expect(preview.added).toBe(0);
    expect(preview.removed).toBe(0);
  });

  it("provides the full change for pagination", () => {
    const before = Array.from({ length: 100 }, (_, i) => `old ${i}`).join("\n");
    const after = Array.from({ length: 100 }, (_, i) => `new ${i}`).join("\n");

    const preview = buildPreviewRows({ before, after });

    expect(preview.rows.filter((row) => row.tone === "add")).toHaveLength(100);
    expect(preview.rows.at(-1)?.text).toBe("+new 99 [no final newline]");
  });

  it("wraps very long lines without discarding content", () => {
    const long = "x".repeat(500);
    const preview = buildPreviewRows({ before: "", after: long });

    const added = preview.rows.find((row) => row.tone === "add")!.text;
    const wrapped = wrapPreviewText(added, 76);
    expect(wrapped).toHaveLength(7);
    expect(wrapped.join("")).toBe(`+${long} [no final newline]`);
  });

  it("distinguishes an empty creation and byte changes caused by line endings", () => {
    expect(buildPreviewRows({ before: "", after: "", createsFile: true }).rows[0]?.text)
      .toBe("Creates an empty file.");
    expect(buildPreviewRows({ before: "a", after: "a\n" }).rows.map((row) => row.text))
      .toEqual([expect.stringMatching(/^@@/), "-a [no final newline]", "+a"]);
    expect(buildPreviewRows({ before: "a\r\n", after: "a\n" }).rows.map((row) => row.text))
      .toEqual([expect.stringMatching(/^@@/), "-a [CRLF]", "+a [LF]"]);
  });

  it("wraps by terminal cells and shows controls without changing graphemes", () => {
    expect(wrapPreviewText("甲乙e\u0301丙", 4)).toEqual(["甲乙", "e\u0301丙"]);
    expect(wrapPreviewText("a\x1b[2J\t\rb", 32)).toEqual(["a\\x1b[2J\\t\\rb"]);
  });
});
