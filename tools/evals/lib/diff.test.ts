import { describe, expect, it } from "vitest";
import type { Baseline, BaselineEntry } from "./baseline.ts";
import { computeDiff } from "./diff.ts";

/** Helper to create a baseline entry. */
function makeEntry(overrides?: Partial<BaselineEntry>): BaselineEntry {
  return { pass: true, scores: {}, toolCalls: [], turns: 1, error: null, ...overrides };
}

/** Helper to create a Baseline with given evals. */
function makeBaseline(evals: Record<string, BaselineEntry>): Baseline {
  return { generatedAt: "2026-02-17T10:00:00.000Z", generatedFrom: "abc123", evals };
}

describe("computeDiff", () => {
  it("detects score regressions", () => {
    const baseline = makeBaseline({
      "agent/test": makeEntry({ scores: { accuracy: 0.9, speed: 0.8 } }),
    });
    const current = makeBaseline({
      "agent/test": makeEntry({ scores: { accuracy: 0.7, speed: 0.8 } }),
    });

    const result = computeDiff(baseline, current);

    expect(result.diffs).toHaveLength(1);
    expect(result.diffs[0]?.status).toBe("regressed");
    expect(result.diffs[0]?.scoreDeltas.accuracy).toBeCloseTo(-0.2, 5);
    expect(result.diffs[0]?.scoreDeltas.speed).toBe(0);
    expect(result.summary.regressed).toBe(1);
  });

  it("detects score improvements", () => {
    const baseline = makeBaseline({ "agent/test": makeEntry({ scores: { accuracy: 0.7 } }) });
    const current = makeBaseline({ "agent/test": makeEntry({ scores: { accuracy: 0.95 } }) });

    const result = computeDiff(baseline, current);

    expect(result.diffs[0]?.status).toBe("improved");
    expect(result.summary.improved).toBe(1);
  });

  it("detects pass -> fail flip as regression", () => {
    const baseline = makeBaseline({ "agent/test": makeEntry({ pass: true }) });
    const current = makeBaseline({
      "agent/test": makeEntry({ pass: false, error: { phase: "assertion" } }),
    });

    const result = computeDiff(baseline, current);

    expect(result.diffs[0]?.status).toBe("regressed");
    expect(result.diffs[0]?.passFlip).toEqual({ from: true, to: false });
  });

  it("detects fail -> pass flip as improvement", () => {
    const baseline = makeBaseline({
      "agent/test": makeEntry({ pass: false, error: { phase: "execution" } }),
    });
    const current = makeBaseline({ "agent/test": makeEntry({ pass: true }) });

    const result = computeDiff(baseline, current);

    expect(result.diffs[0]?.status).toBe("improved");
    expect(result.diffs[0]?.passFlip).toEqual({ from: false, to: true });
  });

  it("marks unchanged evals", () => {
    const entry = makeEntry({ scores: { accuracy: 0.9 }, toolCalls: ["read"], turns: 2 });
    const baseline = makeBaseline({ "agent/test": entry });
    const current = makeBaseline({ "agent/test": { ...entry } });

    const result = computeDiff(baseline, current);

    expect(result.diffs[0]?.status).toBe("unchanged");
    expect(result.summary.unchanged).toBe(1);
  });

  it("detects new evals (in current but not baseline)", () => {
    const baseline = makeBaseline({});
    const current = makeBaseline({ "agent/new": makeEntry() });

    const result = computeDiff(baseline, current);

    expect(result.diffs[0]?.status).toBe("new");
    expect(result.diffs[0]?.current).toBeTruthy();
    expect(result.diffs[0]?.baseline).toBeNull();
    expect(result.summary.new).toBe(1);
  });

  it("detects removed evals (in baseline but not current)", () => {
    const baseline = makeBaseline({ "agent/old": makeEntry() });
    const current = makeBaseline({});

    const result = computeDiff(baseline, current);

    expect(result.diffs[0]?.status).toBe("removed");
    expect(result.diffs[0]?.baseline).toBeTruthy();
    expect(result.diffs[0]?.current).toBeNull();
    expect(result.summary.removed).toBe(1);
  });

  it("detects tool call changes as regression", () => {
    const baseline = makeBaseline({
      "agent/test": makeEntry({ toolCalls: ["read_file", "execute_sql"] }),
    });
    const current = makeBaseline({
      "agent/test": makeEntry({ toolCalls: ["read_file", "web_search"] }),
    });

    const result = computeDiff(baseline, current);

    expect(result.diffs[0]?.status).toBe("regressed");
    expect(result.diffs[0]?.toolCallsChanged).toBe(true);
  });

  it("computes turn deltas", () => {
    const baseline = makeBaseline({ "agent/test": makeEntry({ turns: 3 }) });
    const current = makeBaseline({ "agent/test": makeEntry({ turns: 5 }) });

    const result = computeDiff(baseline, current);

    expect(result.diffs[0]?.turnsDelta).toBe(2);
  });

  it("handles multiple evals with mixed statuses", () => {
    const baseline = makeBaseline({
      "eval/a": makeEntry({ scores: { q: 0.9 } }),
      "eval/b": makeEntry({ pass: true }),
      "eval/c": makeEntry(),
    });
    const current = makeBaseline({
      "eval/a": makeEntry({ scores: { q: 0.95 } }),
      "eval/b": makeEntry({ pass: false, error: { phase: "assertion" } }),
      "eval/d": makeEntry(),
    });

    const result = computeDiff(baseline, current);

    expect(result.diffs).toHaveLength(4);
    expect(result.summary).toEqual({ improved: 1, regressed: 1, unchanged: 0, new: 1, removed: 1 });
  });

  it("sorts diffs by eval name", () => {
    const baseline = makeBaseline({
      "z-eval": makeEntry(),
      "a-eval": makeEntry(),
      "m-eval": makeEntry(),
    });
    const current = makeBaseline({
      "z-eval": makeEntry(),
      "a-eval": makeEntry(),
      "m-eval": makeEntry(),
    });

    const result = computeDiff(baseline, current);
    const names = result.diffs.map((d) => d.evalName);

    expect(names).toEqual(["a-eval", "m-eval", "z-eval"]);
  });

  it("handles empty baselines", () => {
    const result = computeDiff(makeBaseline({}), makeBaseline({}));

    expect(result.diffs).toHaveLength(0);
    expect(result.summary).toEqual({ improved: 0, regressed: 0, unchanged: 0, new: 0, removed: 0 });
  });
});
