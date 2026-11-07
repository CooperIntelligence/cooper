import { describe, expect, it } from "vitest";
import { splitCompletedLines, splitContent } from "../src/stream-lines.js";

describe("splitCompletedLines", () => {
  it("keeps text without a newline in the live buffer", () => {
    expect(splitCompletedLines("", "Hello")).toEqual({
      buffer: "Hello",
      lines: [],
    });
  });

  it("commits a line once its newline arrives", () => {
    expect(splitCompletedLines("Hello", " world\nNext")).toEqual({
      buffer: "Next",
      lines: ["Hello world"],
    });
  });

  it("preserves blank lines", () => {
    expect(splitCompletedLines("", "a\n\nb")).toEqual({
      buffer: "b",
      lines: ["a", ""],
    });
  });

  it("handles multiple newlines in one delta", () => {
    expect(splitCompletedLines("", "a\nb\nc\n")).toEqual({
      buffer: "",
      lines: ["a", "b", "c"],
    });
  });

  it("strips carriage returns from CRLF input", () => {
    expect(splitCompletedLines("", "a\r\nb\r\n")).toEqual({
      buffer: "",
      lines: ["a", "b"],
    });
  });
});

describe("splitContent", () => {
  it("splits lines and drops the trailing newline segment", () => {
    expect(splitContent("a\n\nb\n")).toEqual(["a", "", "b"]);
  });

  it("returns no lines for empty content", () => {
    expect(splitContent("")).toEqual([]);
  });
});
