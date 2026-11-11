import { describe, expect, it } from "vitest";
import { createMarkdownFormatter } from "../src/markdown.js";
import { splitCompletedLines, splitContent } from "../src/stream-lines.js";

describe("assistant Markdown", () => {
  it("formats headings, list markers, emphasis, and inline code", () => {
    const format = createMarkdownFormatter();
    expect(format("## 验证 ##")).toEqual({
      kind: "heading",
      spans: [{ text: "验证" }],
    });
    expect(format("  - **Run** `` npm run `test` `` and _check_ the result.")).toEqual({
      kind: "list",
      prefix: "  • ",
      spans: [
        { text: "Run", bold: true },
        { text: " " },
        { text: "npm run `test`", code: true },
        { text: " and " },
        { text: "check", italic: true },
        { text: " the result." },
      ],
    });
    expect(format("2. **`test_file.ts`**")).toEqual({
      kind: "list",
      prefix: "2. ",
      spans: [{ text: "test_file.ts", bold: true, code: true }],
    });
  });

  it("keeps literal code and requires a matching closing fence", () => {
    const format = createMarkdownFormatter();
    expect(format("~~~~markdown")).toEqual({ kind: "code-label", text: "markdown" });
    expect(format("  # **raw**")).toEqual({ kind: "code", text: "  # **raw**" });
    expect(format("~~~")).toEqual({ kind: "code", text: "~~~" });
    expect(format("~~~~ # literal")).toEqual({ kind: "code", text: "~~~~ # literal" });
    expect(format("~~~~~ ")).toBeNull();
    expect(format("foo_bar and `unfinished")).toEqual({
      kind: "text",
      spans: [{ text: "foo_bar and `unfinished" }],
    });
  });

  it("commits the same rows for streamed fragments and a saved reply", () => {
    const chunks = ["## Run **", "tests**\r", "\n``", "`sh\n  npm ", "test\n`", "``\nDone"];
    const format = createMarkdownFormatter();
    const rows = [];
    let tail = "";
    for (const chunk of chunks) {
      const split = splitCompletedLines(tail, chunk);
      tail = split.buffer;
      rows.push(...split.lines.map(format));
    }
    rows.push(format(tail));

    expect(rows).toEqual(splitContent(chunks.join("")).map(createMarkdownFormatter()));
    expect(rows.filter((line) => line !== null)).toHaveLength(4);
  });
});
