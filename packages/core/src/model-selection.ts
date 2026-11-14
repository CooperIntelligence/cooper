import { z } from "zod";

export const modelTierNames = {
  sera: "Seraphina",
  cher: "Cherubina",
  thr: "Thronia",
} as const;

export const modelTierSchema = z.enum(["sera", "cher", "thr"]);
export type ModelTier = z.infer<typeof modelTierSchema>;

export const reasoningEffortSchema = z.enum([
  "none", "minimal", "low", "medium", "high", "xhigh", "max",
]);
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;

export const modelSelectionSchema = z.object({
  tier: modelTierSchema.nullable(),
  model: z.string().min(1),
  reasoningEffort: reasoningEffortSchema.optional(),
  contextWindow: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive().optional(),
  inputLimit: z.number().int().nonnegative(),
});
export type ModelSelection = z.infer<typeof modelSelectionSchema>;
