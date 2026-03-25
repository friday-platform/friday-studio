import type { AgentBlock } from "@atlas/core/session/session-events";
import { describe, expect, test } from "vitest";
import { computeBarLayouts, computeTotalDurationMs, rowStatusClasses } from "./waterfall-layout.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SESSION_START = "2026-02-13T10:00:00.000Z";

function block(overrides: Partial<AgentBlock> = {}): AgentBlock {
  return {
    agentName: "agent",
    actionType: "agent",
    task: "do stuff",
    status: "completed",
    toolCalls: [],
    output: undefined,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// computeTotalDurationMs
// ---------------------------------------------------------------------------

describe("computeTotalDurationMs", () => {
  test("uses sessionDurationMs when available", () => {
    const result = computeTotalDurationMs([], SESSION_START, 5000);
    expect(result).toBe(5000);
  });

  test("derives span from timestamps when session duration is missing", () => {
    const blocks = [
      block({ startedAt: "2026-02-13T10:00:01.000Z", durationMs: 2000 }),
      block({ startedAt: "2026-02-13T10:00:04.000Z", durationMs: 1000 }),
    ];
    // Latest end: 10:00:05 - session start 10:00:00 = 5000ms
    expect(computeTotalDurationMs(blocks, SESSION_START, undefined)).toBe(5000);
  });

  test("falls back to summed durations with padding when no timestamps", () => {
    const blocks = [block({ durationMs: 1000 }), block({ durationMs: 2000 })];
    // sum = 3000, * 1.2 = 3600
    expect(computeTotalDurationMs(blocks, SESSION_START, undefined)).toBe(3600);
  });

  test("returns 1000 when no duration info at all", () => {
    expect(computeTotalDurationMs([], SESSION_START, undefined)).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
// computeBarLayouts — timestamp-based
// ---------------------------------------------------------------------------

describe("computeBarLayouts (timestamp-based)", () => {
  test("positions bars based on startedAt offset from session start", () => {
    const blocks = [
      block({ startedAt: "2026-02-13T10:00:00.000Z", durationMs: 2000 }),
      block({ startedAt: "2026-02-13T10:00:03.000Z", durationMs: 2000 }),
    ];
    const totalMs = 5000;
    const layouts = computeBarLayouts(blocks, SESSION_START, totalMs);

    // First block: left = 0/5000 = 0%, width = 2000/5000 = 40%
    expect(layouts[0]?.left).toBeCloseTo(0);
    expect(layouts[0]?.width).toBeCloseTo(40);

    // Second block: left = 3000/5000 = 60%, width = 2000/5000 = 40%
    expect(layouts[1]?.left).toBeCloseTo(60);
    expect(layouts[1]?.width).toBeCloseTo(40);
  });

  test("reveals gaps between non-contiguous blocks", () => {
    const blocks = [
      block({ startedAt: "2026-02-13T10:00:00.000Z", durationMs: 1000 }),
      block({ startedAt: "2026-02-13T10:00:04.000Z", durationMs: 1000 }),
    ];
    const totalMs = 5000;
    const layouts = computeBarLayouts(blocks, SESSION_START, totalMs);

    // Gap: block 1 ends at 20%, block 2 starts at 80%
    expect(layouts[0]?.left).toBeCloseTo(0);
    expect(layouts[0]?.width).toBeCloseTo(20);
    expect(layouts[1]?.left).toBeCloseTo(80);
    expect(layouts[1]?.width).toBeCloseTo(20);
  });

  test("shows overlapping concurrent blocks", () => {
    const blocks = [
      block({ startedAt: "2026-02-13T10:00:00.000Z", durationMs: 3000 }),
      block({ startedAt: "2026-02-13T10:00:01.000Z", durationMs: 3000 }),
    ];
    const totalMs = 4000;
    const layouts = computeBarLayouts(blocks, SESSION_START, totalMs);

    // First: left=0%, width=75%; Second: left=25%, width=75%
    expect(layouts[0]?.left).toBeCloseTo(0);
    expect(layouts[0]?.width).toBeCloseTo(75);
    expect(layouts[1]?.left).toBeCloseTo(25);
    expect(layouts[1]?.width).toBeCloseTo(75);
  });
});

// ---------------------------------------------------------------------------
// computeBarLayouts — sequential fallback
// ---------------------------------------------------------------------------

describe("computeBarLayouts (sequential fallback)", () => {
  test("stacks bars end-to-end when startedAt is missing", () => {
    const blocks = [block({ durationMs: 2000 }), block({ durationMs: 3000 })];
    const totalMs = 6000;
    const layouts = computeBarLayouts(blocks, SESSION_START, totalMs);

    // First: left=0%, width=2000/6000=33.3%
    expect(layouts[0]?.left).toBeCloseTo(0);
    expect(layouts[0]?.width).toBeCloseTo(33.33, 1);

    // Second: left=2000/6000=33.3%, width=3000/6000=50%
    expect(layouts[1]?.left).toBeCloseTo(33.33, 1);
    expect(layouts[1]?.width).toBeCloseTo(50);
  });

  test("returns zero layout when totalDurationMs is zero", () => {
    const blocks = [block()];
    const layouts = computeBarLayouts(blocks, SESSION_START, 0);
    expect(layouts[0]?.left).toBe(0);
    expect(layouts[0]?.width).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// rowStatusClasses
// ---------------------------------------------------------------------------

describe("rowStatusClasses", () => {
  test("returns row--failed for failed status", () => {
    expect(rowStatusClasses("failed")).toBe("row--failed");
  });

  test("returns row--running for running status", () => {
    expect(rowStatusClasses("running")).toBe("row--running");
  });

  test("returns empty string for completed status", () => {
    expect(rowStatusClasses("completed")).toBe("");
  });

  test("returns empty string for pending status", () => {
    expect(rowStatusClasses("pending")).toBe("");
  });

  test("returns row--skipped for skipped status", () => {
    expect(rowStatusClasses("skipped")).toBe("row--skipped");
  });
});
