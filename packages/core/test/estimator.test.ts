import { describe, expect, it } from "vitest";
import type { Message, ToolSpec } from "../src/types.js";
import {
  INITIAL_CALIBRATION,
  applyCalibration,
  estimateConversationTokens,
  estimateMessageTokens,
  estimateTextTokens,
  estimateToolSpecTokens,
  updateCalibration,
} from "../src/context/estimator.js";

describe("estimateTextTokens", () => {
  it("treats Latin text as ~3.6 characters per token", () => {
    expect(estimateTextTokens("")).toBe(0);
    expect(estimateTextTokens("a".repeat(360))).toBe(100);
  });

  it("treats CJK text as ~1 token per character", () => {
    expect(estimateTextTokens("中文测试")).toBe(5);
    // Eleven CJK characters cost far more than eleven Latin ones.
    expect(estimateTextTokens("中文测试上下文窗口管理")).toBeGreaterThan(
      estimateTextTokens("a".repeat(11)),
    );
  });

  it("handles mixed text without counting characters twice", () => {
    const mixed = "修复 read_file 的 bug";
    const cjk = "修复的";
    expect(estimateTextTokens(mixed)).toBeGreaterThan(
      estimateTextTokens(cjk),
    );
  });
});

describe("estimateMessageTokens", () => {
  it("adds per-message overhead", () => {
    const message: Message = { role: "user", content: "hello" };
    expect(estimateMessageTokens(message)).toBeGreaterThan(
      estimateTextTokens("hello"),
    );
  });

  it("counts tool call arguments", () => {
    const plain: Message = { role: "assistant", content: "x".repeat(200) };
    const calling: Message = {
      role: "assistant",
      content: "x".repeat(200),
      toolCalls: [
        { id: "c1", name: "write_file", arguments: JSON.stringify({ content: "y".repeat(400) }) },
      ],
    };
    expect(estimateMessageTokens(calling)).toBeGreaterThan(
      estimateMessageTokens(plain),
    );
  });
});

describe("estimateConversationTokens", () => {
  it("includes tool schemas, which are resent every request", () => {
    const messages: Message[] = [{ role: "user", content: "hi" }];
    const tools: ToolSpec[] = [
      {
        name: "read_file",
        description: "Read a file.",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    ];
    expect(estimateConversationTokens(messages, tools)).toBe(
      estimateConversationTokens(messages) + estimateToolSpecTokens(tools),
    );
    expect(estimateConversationTokens(messages, tools)).toBeGreaterThan(
      estimateConversationTokens(messages),
    );
  });
});

describe("calibration", () => {
  it("learns from reported usage", () => {
    const first = updateCalibration(INITIAL_CALIBRATION, 1500, 1000);
    expect(first.ratio).toBeCloseTo(1.5);
    expect(first.samples).toBe(1);

    const second = updateCalibration(first, 1000, 1000);
    expect(second.ratio).toBeCloseTo(1.35);
    expect(second.samples).toBe(2);
  });

  it("clamps outliers and ignores nonsense", () => {
    expect(updateCalibration(INITIAL_CALIBRATION, 100_000, 1000).ratio).toBe(1.5);
    expect(updateCalibration(INITIAL_CALIBRATION, 0, 1000)).toEqual(
      INITIAL_CALIBRATION,
    );
    expect(updateCalibration(INITIAL_CALIBRATION, 1000, 0)).toEqual(
      INITIAL_CALIBRATION,
    );
  });

  it("applies the learned multiplier", () => {
    expect(applyCalibration(1000, { ratio: 1.2, samples: 3 })).toBe(1200);
  });
});
