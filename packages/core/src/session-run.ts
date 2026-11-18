import { z } from "zod";

export const stopCauseSchema = z.enum(["user-stop", "host-shutdown"]);
export type StopCause = z.infer<typeof stopCauseSchema>;
export const runStatusSchema = z.enum(["completed", "stopped", "interrupted", "failed", "limit-reached"]);
export type RunStatus = z.infer<typeof runStatusSchema>;
export const runReasonSchema = z.enum([
  "completed", "user-stop", "host-shutdown", "provider-error", "storage-error", "tool-error", "limit-reached", "unknown",
]);
export type RunReason = z.infer<typeof runReasonSchema>;
export const runPhaseSchema = z.enum(["model", "approval", "tool", "storage"]);
export type RunPhase = z.infer<typeof runPhaseSchema>;

const ids = { turnId: z.string().min(1), runId: z.string().min(1) };
const at = z.string();
export const lifecycleRecordSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("run-start"), at, ...ids, reviewOnly: z.boolean().optional(), reviewConfirmed: z.boolean().optional() }),
  z.object({ type: z.literal("stop-requested"), at, ...ids, reason: stopCauseSchema }),
  z.object({ type: z.literal("run-end"), at, ...ids, status: runStatusSchema, reason: runReasonSchema,
    phase: runPhaseSchema.optional(), source: z.enum(["observed", "recovered"]) }),
  z.object({ type: z.literal("tool-dispatched"), at, ...ids, assistantId: z.string(), callId: z.string(),
    toolName: z.string(), mutable: z.boolean() }),
]);
export type LifecycleRecord = z.infer<typeof lifecycleRecordSchema>;
export type RunEnd = Extract<LifecycleRecord, { type: "run-end" }>;

export const messageMetaSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("submission"), requestId: z.string(), turnId: z.string() }),
  z.object({ kind: z.literal("assistant"), ...ids, assistantId: z.string(), final: z.boolean() }),
  z.object({ kind: z.literal("tool"), ...ids, assistantId: z.string(), callId: z.string() }),
]);
export type MessageMeta = z.infer<typeof messageMetaSchema>;

export type SessionRun = {
  turnId: string;
  runId: string;
  startedAt: string;
  stopRequested?: StopCause;
  end?: RunEnd;
  reviewOnly?: boolean;
  reviewConfirmed?: boolean;
};

export type Submission = { requestId: string; turnId: string; text: string };
