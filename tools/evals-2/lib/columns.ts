import type { Evalite } from "evalite";

/**
 * Calculates total execution time from traces (earliest start to latest end)
 * @returns Duration in milliseconds
 */
export function getTraceDuration(traces: Evalite.Trace[]): number {
  if (traces.length === 0) return 0;
  const start = Math.min(...traces.map((t) => t.start));
  const end = Math.max(...traces.map((t) => t.end));
  return end - start;
}

/**
 * Formats milliseconds as a human-readable duration string
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
