import { describe, expect, it } from "vitest";
import { compareRuns } from "./compare.ts";
import type { EvalResult } from "./output.ts";

function unreachable(): never {
  throw new Error("expected element to exist");
}

/** Creates a minimal EvalResult for testing. */
function makeResult(overrides: Partial<EvalResult> & { evalName: string }): EvalResult {
  return {
    scores: [],
    traces: [],
    metadata: {},
    timestamp: "2026-02-19T10:00:00.000Z",
    ...overrides,
  };
}

/** Shorthand: result that passed (no error in metadata). */
function passing(
  evalName: string,
  scores: Record<string, number> = {},
  extra?: Partial<EvalResult>,
): EvalResult {
  return makeResult({
    evalName,
    scores: Object.entries(scores).map(([name, value]) => ({ name, value })),
    ...extra,
  });
}

/** Shorthand: result that failed (has metadata.error). */
function failing(
  evalName: string,
  scores: Record<string, number> = {},
  extra?: Partial<EvalResult>,
): EvalResult {
  return makeResult({
    evalName,
    scores: Object.entries(scores).map(([name, value]) => ({ name, value })),
    ...extra,
    metadata: { error: { phase: "assertion", message: "failed" }, ...extra?.metadata },
  });
}

describe("compareRuns", () => {
  it("classifies fail→pass as improved", () => {
    const before = [failing("eval/a", { accuracy: 0 })];
    const after = [passing("eval/a", { accuracy: 1 })];

    const result = compareRuns(before, after);

    expect(result.improved).toHaveLength(1);
    expect(result.improved[0]?.evalName).toBe("eval/a");
    expect(result.improved[0]?.before.pass).toBe(false);
    expect(result.improved[0]?.after.pass).toBe(true);
    expect(result.summary.improved).toBe(1);
  });

  it("classifies pass→fail as regressed", () => {
    const before = [passing("eval/a", { accuracy: 1 })];
    const after = [failing("eval/a", { accuracy: 0 })];

    const result = compareRuns(before, after);

    expect(result.regressed).toHaveLength(1);
    expect(result.regressed[0]?.evalName).toBe("eval/a");
    expect(result.regressed[0]?.before.pass).toBe(true);
    expect(result.regressed[0]?.after.pass).toBe(false);
    expect(result.summary.regressed).toBe(1);
  });

  it("classifies both-pass with same scores as unchanged (compact entry)", () => {
    const before = [passing("eval/a", { accuracy: 0.9 })];
    const after = [passing("eval/a", { accuracy: 0.9 })];

    const result = compareRuns(before, after);

    expect(result.unchanged).toHaveLength(1);
    const entry = result.unchanged[0];
    expect(entry?.evalName).toBe("eval/a");
    expect(entry?.before.pass).toBe(true);
    // Compact: unchanged passing cases should not include scores/result
    expect(entry?.before.scores).toEqual({});
    expect(entry?.after.scores).toEqual({});
  });

  it("classifies both-fail as unchanged with full entry", () => {
    const before = [failing("eval/a", { accuracy: 0.2 })];
    const after = [failing("eval/a", { accuracy: 0.2 })];

    const result = compareRuns(before, after);

    expect(result.unchanged).toHaveLength(1);
    const entry = result.unchanged[0];
    expect(entry?.evalName).toBe("eval/a");
    expect(entry?.before.pass).toBe(false);
    // Full entry: unchanged failing cases include scores
    expect(entry?.before.scores).toEqual({ accuracy: 0.2 });
    expect(entry?.after.scores).toEqual({ accuracy: 0.2 });
  });

  it("classifies mixed scores (one up, one down) as regressed", () => {
    const before = [passing("eval/a", { accuracy: 0.8, speed: 0.9 })];
    const after = [passing("eval/a", { accuracy: 0.95, speed: 0.7 })];

    const result = compareRuns(before, after);

    expect(result.regressed).toHaveLength(1);
    expect(result.summary.regressed).toBe(1);
  });

  it("reports cases present only in after", () => {
    const before: EvalResult[] = [];
    const after = [passing("eval/new")];

    const result = compareRuns(before, after);

    // New cases should not silently drop
    expect(result.improved).toHaveLength(0);
    expect(result.regressed).toHaveLength(0);
    expect(result.unchanged).toHaveLength(0);
    expect(result.addedEvals).toEqual(["eval/new"]);
    expect(result.removedEvals).toBeUndefined();
    // Total should reflect it
    expect(result.summary.total).toBe(1);
  });

  it("reports cases present only in before", () => {
    const before = [passing("eval/old")];
    const after: EvalResult[] = [];

    const result = compareRuns(before, after);

    expect(result.improved).toHaveLength(0);
    expect(result.regressed).toHaveLength(0);
    expect(result.unchanged).toHaveLength(0);
    expect(result.removedEvals).toEqual(["eval/old"]);
    expect(result.addedEvals).toBeUndefined();
    expect(result.summary.total).toBe(1);
  });

  it("deduplicates by evalName using latest runId timestamp", () => {
    const before = [
      passing(
        "eval/a",
        { accuracy: 0.5 },
        { runId: "run-old", timestamp: "2026-02-19T09:00:00.000Z" },
      ),
      passing(
        "eval/a",
        { accuracy: 0.8 },
        { runId: "run-new", timestamp: "2026-02-19T11:00:00.000Z" },
      ),
    ];
    const after = [passing("eval/a", { accuracy: 0.9 })];

    const result = compareRuns(before, after);

    // Should use the latest (run-new, accuracy: 0.8) not the older one
    expect(result.improved).toHaveLength(1);
    expect(result.improved[0]?.before.scores).toEqual({ accuracy: 0.8 });
  });

  it("includes scoreReasons and promptDiff in verbose mode", () => {
    const before = [
      passing(
        "eval/a",
        { accuracy: 0.5 },
        { metadata: { promptSnapshot: "You are a planner v1" } },
      ),
    ];
    // Add reason to the score
    const beforeEntry = before[0] ?? unreachable();
    beforeEntry.scores = [{ name: "accuracy", value: 0.5, reason: "missed edge case" }];

    const after = [
      passing(
        "eval/a",
        { accuracy: 0.9 },
        { metadata: { promptSnapshot: "You are a planner v2" } },
      ),
    ];
    const afterEntry = after[0] ?? unreachable();
    afterEntry.scores = [{ name: "accuracy", value: 0.9, reason: "handled all cases" }];

    const result = compareRuns(before, after, { verbose: true });

    expect(result.improved).toHaveLength(1);
    const entry = result.improved[0];
    expect(entry?.scoreReasons).toEqual({
      before: { accuracy: "missed edge case" },
      after: { accuracy: "handled all cases" },
    });
    expect(entry?.promptDiff).toBeDefined();
    expect(entry?.promptDiff).toContain("planner v1");
    expect(entry?.promptDiff).toContain("planner v2");
  });

  it("computes correct summary counts", () => {
    const before = [
      passing("eval/a", { accuracy: 0.9 }),
      passing("eval/b", { accuracy: 1 }),
      failing("eval/c", { accuracy: 0 }),
      passing("eval/d", { accuracy: 0.8 }),
    ];
    const after = [
      passing("eval/a", { accuracy: 0.9 }), // unchanged
      failing("eval/b", { accuracy: 0.5 }), // regressed
      passing("eval/c", { accuracy: 1 }), // improved
      passing("eval/d", { accuracy: 0.95 }), // improved (score up, no decrease)
    ];

    const result = compareRuns(before, after);

    expect(result.summary).toMatchObject({
      total: 4,
      improved: 2,
      regressed: 1,
      unchanged: 1,
      beforePass: 3,
      afterPass: 3,
    });
  });

  it("includes metadata.result in improved/regressed entries", () => {
    const agentResult = { agents: [{ name: "Slack Agent", needs: ["slack"] }] };
    const before = [
      failing(
        "eval/a",
        {},
        { metadata: { error: { phase: "assertion", message: "wrong" }, result: { agents: [] } } },
      ),
    ];
    const after = [passing("eval/a", { accuracy: 1 }, { metadata: { result: agentResult } })];

    const result = compareRuns(before, after);

    expect(result.improved).toHaveLength(1);
    expect(result.improved[0]?.after.result).toEqual(agentResult);
    expect(result.improved[0]?.before.result).toEqual({ agents: [] });
  });

  it("uses custom labels", () => {
    const result = compareRuns([], [], { beforeLabel: "baseline", afterLabel: "collapse-v1" });

    expect(result.before).toBe("baseline");
    expect(result.after).toBe("collapse-v1");
  });

  it("defaults labels to 'before' and 'after'", () => {
    const result = compareRuns([], []);

    expect(result.before).toBe("before");
    expect(result.after).toBe("after");
  });
});
