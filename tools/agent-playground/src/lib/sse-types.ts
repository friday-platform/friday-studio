import type { DoneStats, LogEntry, TraceEntry } from "./server/lib/sse.ts";

/**
 * Shared SSE event types for bundled agent execution streams.
 *
 * Consolidates the `SSEEvent` discriminated union that was duplicated across
 * the built-in page, execution-stream, output-tabs, and run-card components.
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
  | { type: "done"; data: DoneStats }
  | { type: "error"; data: { error: string } };
