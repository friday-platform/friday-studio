import type { AgentBlock } from "@atlas/core/session/session-events";
import { describe, expect, test } from "vitest";
import { computeBarLayouts, computeTotalDurationMs, rowStatusClasses } from "./waterfall-layout.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SESSION_START = "2026-02-13T10:00:00.000Z";
const SESSION_START_EPOCH = Date.parse(SESSION_START);

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
  const now = SESSION_START_EPOCH + 10000; // arbitrary future time

  test("uses sessionDurationMs when available", () => {
    const result = computeTotalDurationMs([], SESSION_START, 5000, now);
    expect(result).toBe(5000);
  });

  test("derives span from timestamps when session duration is missing", () => {
    const blocks = [
      block({ startedAt: "2026-02-13T10:00:01.000Z", durationMs: 2000 }),
      block({ startedAt: "2026-02-13T10:00:04.000Z", durationMs: 1000 }),
    ];
    // Latest end: 10:00:05 - session start 10:00:00 = 5000ms
    expect(computeTotalDurationMs(blocks, SESSION_START, undefined, now)).toBe(5000);
  });

  test("extends span to include running block elapsed time", () => {
    const runningStart = "2026-02-13T10:00:02.000Z";
    const blocks = [
      block({ startedAt: "2026-02-13T10:00:00.000Z", durationMs: 1000 }),
      block({ startedAt: runningStart, status: "running" }),
    ];
    const runningNow = SESSION_START_EPOCH + 7000; // 7s after session start
    // Running block started at +2s, now is +7s → running end = now = +7s
    // Completed block end = +0s + 1000ms = +1s
    // Max end = +7s → span = 7000ms
    expect(computeTotalDurationMs(blocks, SESSION_START, undefined, runningNow)).toBe(7000);
  });

  test("running block without startedAt falls back to minimum duration", () => {
    const blocks = [block({ status: "running" })]; // no startedAt, no durationMs
    // No timestamps → sequential fallback, sum = 0, returns minimum 1000ms
    expect(computeTotalDurationMs(blocks, SESSION_START, undefined, now)).toBe(1000);
  });

  test("falls back to summed durations with padding when no timestamps", () => {
    const blocks = [block({ durationMs: 1000 }), block({ durationMs: 2000 })];
    // sum = 3000, * 1.2 = 3600
    expect(computeTotalDurationMs(blocks, SESSION_START, undefined, now)).toBe(3600);
  });

  test("returns 1000 when no duration info at all", () => {
    expect(computeTotalDurationMs([], SESSION_START, undefined, now)).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
// computeBarLayouts — timestamp-based
// ---------------------------------------------------------------------------

describe("computeBarLayouts (timestamp-based)", () => {
  const now = SESSION_START_EPOCH + 10000;

  test("positions bars based on startedAt offset from session start", () => {
    const blocks = [
      block({ startedAt: "2026-02-13T10:00:00.000Z", durationMs: 2000 }),
      block({ startedAt: "2026-02-13T10:00:03.000Z", durationMs: 2000 }),
    ];
    const totalMs = 5000;
    const layouts = computeBarLayouts(blocks, SESSION_START, totalMs, now);

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
    const layouts = computeBarLayouts(blocks, SESSION_START, totalMs, now);

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
    const layouts = computeBarLayouts(blocks, SESSION_START, totalMs, now);

    // First: left=0%, width=75%; Second: left=25%, width=75%
    expect(layouts[0]?.left).toBeCloseTo(0);
    expect(layouts[0]?.width).toBeCloseTo(75);
    expect(layouts[1]?.left).toBeCloseTo(25);
    expect(layouts[1]?.width).toBeCloseTo(75);
  });

  test("running block width grows proportionally with elapsed time", () => {
    const runningStart = "2026-02-13T10:00:02.000Z";
    const runningNow = SESSION_START_EPOCH + 5000; // 5s after session start
    const blocks = [
      block({ startedAt: "2026-02-13T10:00:00.000Z", durationMs: 1000 }),
      block({ startedAt: runningStart, status: "running" }),
    ];
    const totalMs = 5000;
    const layouts = computeBarLayouts(blocks, SESSION_START, totalMs, runningNow);

    // Running block: started at +2s, now at +5s → elapsed = 3s
    // width = 3000/5000 * 100 = 60%
    expect(layouts[1]?.left).toBeCloseTo(40); // 2000/5000 * 100
    expect(layouts[1]?.width).toBeCloseTo(60); // 3000/5000 * 100
  });

  test("running block without startedAt uses fixed fallback width", () => {
    const blocks = [block({ status: "running" })]; // no startedAt
    const totalMs = 10000;
    const layouts = computeBarLayouts(blocks, SESSION_START, totalMs, now);
    expect(layouts[0]?.width).toBe(15); // fixed fallback
  });
});

// ---------------------------------------------------------------------------
// computeBarLayouts — sequential fallback
// ---------------------------------------------------------------------------

describe("computeBarLayouts (sequential fallback)", () => {
  const now = SESSION_START_EPOCH + 10000;

  test("stacks bars end-to-end when startedAt is missing", () => {
    const blocks = [block({ durationMs: 2000 }), block({ durationMs: 3000 })];
    const totalMs = 6000;
    const layouts = computeBarLayouts(blocks, SESSION_START, totalMs, now);

    // First: left=0%, width=2000/6000=33.3%
    expect(layouts[0]?.left).toBeCloseTo(0);
    expect(layouts[0]?.width).toBeCloseTo(33.33, 1);

    // Second: left=2000/6000=33.3%, width=3000/6000=50%
    expect(layouts[1]?.left).toBeCloseTo(33.33, 1);
    expect(layouts[1]?.width).toBeCloseTo(50);
  });

  test("returns zero layout when totalDurationMs is zero", () => {
    const blocks = [block()];
    const layouts = computeBarLayouts(blocks, SESSION_START, 0, now);
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
