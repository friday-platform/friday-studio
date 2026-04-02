/**
 * Pure positioning math for the waterfall timeline.
 *
 * Two layout modes:
 * - **Timestamp-based**: uses `block.startedAt` to place bars on an honest
 *   timeline, revealing gaps and concurrency.
 * - **Sequential fallback**: stacks bars end-to-end when `startedAt` is missing
 *   (backward compatibility with older session data).
 *
 * @module
 */

import type { AgentBlock } from "@atlas/core/session/session-events";

export interface BarLayout {
  /** Percentage offset from the left edge of the timeline. */
  left: number;
  /** Percentage width of the bar. */
  width: number;
}

/**
 * Compute the total timeline span in milliseconds.
 *
 * When session `durationMs` is available, use it. Otherwise derive from the
 * blocks themselves — either from real timestamps or by summing durations.
 * For running sessions, extends the span to include elapsed time of running blocks.
 *
 * @param now - Current timestamp in ms, used to compute running block elapsed time
 */
export function computeTotalDurationMs(
  blocks: AgentBlock[],
  sessionStartedAt: string,
  sessionDurationMs: number | undefined,
  now: number,
): number {
  const skippedCount = blocks.filter((b) => b.status === "skipped").length;

  if (sessionDurationMs) {
    // Pad timeline so skipped markers have room to cascade after real bars
    return skippedCount > 0 ? sessionDurationMs * (1 + skippedCount * 0.05) : sessionDurationMs;
  }

  // Try timestamp-based span: latest (startedAt + durationMs) - sessionStart
  const sessionStartEpoch = Date.parse(sessionStartedAt);
  if (sessionStartEpoch && hasTimestamps(blocks)) {
    let maxEnd = 0;
    for (const block of blocks) {
      if (block.startedAt) {
        const blockStart = Date.parse(block.startedAt);
        const end =
          block.status === "running"
            ? now
            : blockStart + (block.durationMs ?? 0);
        if (end > maxEnd) maxEnd = end;
      }
    }
    if (maxEnd > sessionStartEpoch) {
      return maxEnd - sessionStartEpoch;
    }
  }

  // Sequential fallback: sum of durations with padding
  let sum = 0;
  for (const block of blocks) {
    if (block.durationMs) sum += block.durationMs;
  }
  return sum > 0 ? sum * 1.2 : 1000;
}

/**
 * Compute bar left/width percentages for each block.
 *
 * Returns one `BarLayout` per block. Running blocks grow proportionally
 * based on elapsed time; completed blocks use their recorded duration.
 *
 * @param now - Current timestamp in ms, used to compute running block widths
 */
export function computeBarLayouts(
  blocks: AgentBlock[],
  sessionStartedAt: string,
  totalDurationMs: number,
  now: number,
): BarLayout[] {
  if (totalDurationMs <= 0) {
    return blocks.map(() => ({ left: 0, width: 0 }));
  }

  const useTimestamps = hasTimestamps(blocks);
  const sessionStartEpoch = Date.parse(sessionStartedAt);

  if (useTimestamps && sessionStartEpoch) {
    const layouts: BarLayout[] = [];
    for (const block of blocks) {
      const prev = layouts[layouts.length - 1];
      const left = block.startedAt
        ? ((Date.parse(block.startedAt) - sessionStartEpoch) / totalDurationMs) * 100
        : prev
          ? prev.left + prev.width
          : 0;
      const width = Math.min(barWidth(block, totalDurationMs, now), 100 - left);
      layouts.push({ left, width });
    }
    return layouts;
  }

  // Sequential fallback
  let cursor = 0;
  return blocks.map((block) => {
    const left = (cursor / totalDurationMs) * 100;
    const width = barWidth(block, totalDurationMs, now);
    if (block.durationMs) cursor += block.durationMs;
    return { left, width };
  });
}

/**
 * Check whether at least one non-pending block has a `startedAt` timestamp.
 * If so, we use timestamp-based positioning for all blocks.
 */
function hasTimestamps(blocks: AgentBlock[]): boolean {
  return blocks.some((b) => b.status !== "pending" && b.startedAt);
}

type BlockStatus = AgentBlock["status"];

/** CSS modifier classes for a waterfall row based on block status. */
export function rowStatusClasses(status: BlockStatus): string {
  switch (status) {
    case "failed":
      return "row--failed";
    case "running":
      return "row--running";
    case "skipped":
      return "row--skipped";
    default:
      return "";
  }
}

function barWidth(block: AgentBlock, totalDurationMs: number, now: number): number {
  if (totalDurationMs <= 0) return 0.5;
  if (block.status === "skipped") return 3;
  if (block.status === "running") {
    if (block.startedAt) {
      const elapsed = now - Date.parse(block.startedAt);
      return Math.max((elapsed / totalDurationMs) * 100, 0.5);
    }
    return 15; // fallback when no startedAt
  }
  if (block.durationMs) return Math.max((block.durationMs / totalDurationMs) * 100, 0.5);
  return 1;
}
