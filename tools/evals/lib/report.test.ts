import { describe, expect, it } from "vitest";
import type { EvalResult } from "./output.ts";
import { buildReport } from "./report.ts";

/** Helper to create a minimal EvalResult for report tests. */
function makeResult(overrides: Partial<EvalResult> & Pick<EvalResult, "evalName">): EvalResult {
  return {
    scores: [],
    traces: [],
    metadata: {},
    timestamp: "2026-02-17T10:00:00.000Z",
    ...overrides,
  };
}

describe("buildReport", () => {
  it("builds rows from grouped results with scores and token counts", () => {
    const results = new Map<string, EvalResult[]>([
      [
        "agent/test",
        [
          makeResult({
            evalName: "agent/test",
            scores: [
              { name: "accuracy", value: 0.9 },
              { name: "speed", value: 0.8 },
            ],
            traces: [
              {
                type: "generate",
                modelId: "claude",
                input: [],
                output: { text: "", toolCalls: [] },
                usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
                startMs: 0,
                endMs: 100,
              },
            ],
          }),
        ],
      ],
    ]);

    const report = buildReport(results);

    expect(report.rows).toHaveLength(1);
    expect(report.rows).toContainEqual(
      expect.objectContaining({
        evalName: "agent/test",
        passed: true,
        scores: { accuracy: 0.9, speed: 0.8 },
        tokens: 150,
      }),
    );
    expect(report.summary.total).toBe(1);
    expect(report.summary.passed).toBe(1);
    expect(report.summary.failed).toBe(0);
    expect(report.summary.avgScore).toBeCloseTo(0.85, 5);
    expect(report.summary.totalTokens).toBe(150);
  });

  it("marks evals with error metadata as failed", () => {
    const results = new Map<string, EvalResult[]>([
      [
        "broken-eval",
        [
          makeResult({
            evalName: "broken-eval",
            metadata: { error: { phase: "execution", message: "boom" } },
          }),
        ],
      ],
    ]);

    const report = buildReport(results);

    expect(report.rows).toContainEqual(
      expect.objectContaining({ evalName: "broken-eval", passed: false }),
    );
    expect(report.summary).toMatchObject({ total: 1, passed: 0, failed: 1 });
  });

  it("uses latest result per evalName when multiple exist", () => {
    const results = new Map<string, EvalResult[]>([
      [
        "agent/test",
        [
          makeResult({
            evalName: "agent/test",
            timestamp: "2026-02-17T10:00:00.000Z",
            scores: [{ name: "accuracy", value: 0.5 }],
          }),
          makeResult({
            evalName: "agent/test",
            timestamp: "2026-02-17T11:00:00.000Z",
            scores: [{ name: "accuracy", value: 0.9 }],
          }),
        ],
      ],
    ]);

    const report = buildReport(results);

    expect(report.rows).toHaveLength(1);
    expect(report.rows).toContainEqual(expect.objectContaining({ scores: { accuracy: 0.9 } }));
  });

  it("returns empty report for empty input", () => {
    const report = buildReport(new Map());

    expect(report.rows).toHaveLength(0);
    expect(report.summary).toMatchObject({
      total: 0,
      passed: 0,
      failed: 0,
      avgScore: 0,
      totalTokens: 0,
    });
  });
});
