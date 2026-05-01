/**
 * Types for workspace FSM execution reports.
 *
 * @module
 */
import { z } from "zod";

export type StateTransition = { from: string; to: string; signal: string; timestamp: number };

const StateTransitionSchema = z.object({
  from: z.string(),
  to: z.string(),
  signal: z.string(),
  timestamp: z.number(),
});

const ExecutionReportSchema = z.object({
  success: z.boolean(),
  finalState: z.string(),
  stateTransitions: z.array(StateTransitionSchema),
  resultSnapshots: z.record(z.string(), z.record(z.string(), z.record(z.string(), z.unknown()))),
  actionTrace: z.array(
    z.object({
      state: z.string(),
      actionType: z.string(),
      actionId: z.string().optional(),
      input: z
        .object({
          task: z.string().optional(),
          config: z.record(z.string(), z.unknown()).optional(),
        })
        .optional(),
      status: z.enum(["started", "completed", "failed"]),
      error: z.string().optional(),
    }),
  ),
  assertions: z.array(
    z.object({ check: z.string(), passed: z.boolean(), detail: z.string().optional() }),
  ),
  error: z.string().optional(),
  durationMs: z.number(),
});

export type ExecutionReport = z.infer<typeof ExecutionReportSchema>;

/** A single action trace entry. */
export type ActionEntry = ExecutionReport["actionTrace"][number];
