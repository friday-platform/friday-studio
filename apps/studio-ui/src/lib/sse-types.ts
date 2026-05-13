import { z } from "zod";
import type { DoneStats, LogEntry, TraceEntry } from "./server/lib/sse.ts";

/**
 * Shared SSE event types and Zod schema for agent execution streams.
 *
 * Consolidates the `SSEEvent` discriminated union and `SSEEventSchema` that
 * were duplicated across execution-context, generation-bar, execution-panel,
 * and other components.
 *
 * @module
 */

export type { DoneStats, LogEntry, TraceEntry } from "./server/lib/sse.ts";

/** Discriminated union of all SSE event types emitted during agent execution. */
export type SSEEvent =
  | { type: "progress"; data: { type: string; [key: string]: unknown } }
  | { type: "log"; data: LogEntry }
  | { type: "trace"; data: TraceEntry }
  | { type: "result"; data: unknown }
  | { type: "done"; data: DoneStats & { slug?: string; success?: boolean } }
  | { type: "error"; data: { error: string } }
  | { type: "artifact"; data: { name: string; content: string } };

/** Zod schema for a single SSE event from the wire. Superset of all consumer variants. */
export const SSEEventSchema = z.union([
  z.object({ type: z.literal("progress"), data: z.object({ type: z.string() }).passthrough() }),
  z.object({
    type: z.literal("log"),
    data: z.object({ level: z.string(), message: z.string() }).passthrough(),
  }),
  z.object({
    type: z.literal("trace"),
    data: z
      .object({ spanId: z.string(), name: z.string(), durationMs: z.number() })
      .passthrough(),
  }),
  z.object({ type: z.literal("result"), data: z.unknown() }),
  z.object({
    type: z.literal("done"),
    data: z.object({
      durationMs: z.number(),
      totalTokens: z.number().optional(),
      stepCount: z.number().optional(),
      slug: z.string().optional(),
      success: z.boolean().optional(),
    }),
  }),
  z.object({ type: z.literal("error"), data: z.object({ error: z.string() }) }),
  z.object({
    type: z.literal("artifact"),
    data: z.object({ name: z.string(), content: z.string() }),
  }),
]);
