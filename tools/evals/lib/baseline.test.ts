import { describe, expect, it } from "vitest";
import { extractBaseline } from "./baseline.ts";
import type { EvalResult } from "./output.ts";

/** Helper to create a minimal EvalResult for baseline tests. */
function makeResult(overrides: Partial<EvalResult> & Pick<EvalResult, "evalName">): EvalResult {
  return {
    scores: [],
    traces: [],
    metadata: {},
    timestamp: "2026-02-17T10:00:00.000Z",
    ...overrides,
  };
}

describe("extractBaseline", () => {
  it("extracts pass/fail, scores, tool calls, and turn count", () => {
    const grouped = new Map<string, EvalResult[]>([
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
                output: {
                  text: "Let me check.",
                  toolCalls: [{ name: "execute_sql", input: { sql: "SELECT 1" } }],
                },
                usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
                startMs: 0,
                endMs: 1000,
              },
              {
                type: "generate",
                modelId: "claude",
                input: [],
                output: {
                  text: "Done.",
                  toolCalls: [{ name: "save_results", input: { sql: "SELECT 2" } }],
                },
                usage: { inputTokens: 200, outputTokens: 30, totalTokens: 230 },
                startMs: 1100,
                endMs: 2000,
              },
            ],
          }),
        ],
      ],
    ]);

    const baseline = extractBaseline(grouped, "abc123");

    expect(baseline.generatedFrom).toBe("abc123");
    expect(baseline.generatedAt).toBeTruthy();

    const entry = baseline.evals["agent/test"];
    if (!entry) throw new Error("expected entry for agent/test");
    expect(entry.pass).toBe(true);
    expect(entry.scores).toEqual({ accuracy: 0.9, speed: 0.8 });
    expect(entry.toolCalls).toEqual(["execute_sql", "save_results"]);
    expect(entry.turns).toBe(2);
    expect(entry.error).toBeNull();
  });

  it("marks failed evals with error phase", () => {
    const grouped = new Map<string, EvalResult[]>([
      [
        "broken/eval",
        [
          makeResult({
            evalName: "broken/eval",
            metadata: { error: { phase: "execution", message: "boom" } },
          }),
        ],
      ],
    ]);

    const baseline = extractBaseline(grouped, "def456");
    const entry = baseline.evals["broken/eval"];
    if (!entry) throw new Error("expected entry for broken/eval");
    expect(entry.pass).toBe(false);
    expect(entry.error).toEqual({ phase: "execution" });
  });

  it("uses latest result per eval when multiple exist", () => {
    const grouped = new Map<string, EvalResult[]>([
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
            scores: [{ name: "accuracy", value: 0.95 }],
          }),
        ],
      ],
    ]);

    const baseline = extractBaseline(grouped, "abc");
    const entry = baseline.evals["agent/test"];
    if (!entry) throw new Error("expected entry for agent/test");
    expect(entry.scores).toEqual({ accuracy: 0.95 });
  });

  it("collects tool calls across all traces in order", () => {
    const grouped = new Map<string, EvalResult[]>([
      [
        "multi-tool/eval",
        [
          makeResult({
            evalName: "multi-tool/eval",
            traces: [
              {
                type: "generate",
                modelId: "claude",
                input: [],
                output: {
                  text: "",
                  toolCalls: [
                    { name: "read_file", input: {} },
                    { name: "execute_sql", input: {} },
                  ],
                },
                usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
                startMs: 0,
                endMs: 100,
              },
              {
                type: "generate",
                modelId: "claude",
                input: [],
                output: { text: "", toolCalls: [{ name: "save_results", input: {} }] },
                usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
                startMs: 200,
                endMs: 300,
              },
            ],
          }),
        ],
      ],
    ]);

    const baseline = extractBaseline(grouped, "abc");
    const entry = baseline.evals["multi-tool/eval"];
    if (!entry) throw new Error("expected entry for multi-tool/eval");
    expect(entry.toolCalls).toEqual(["read_file", "execute_sql", "save_results"]);
  });

  it("handles evals with no traces or scores", () => {
    const grouped = new Map<string, EvalResult[]>([
      ["empty/eval", [makeResult({ evalName: "empty/eval" })]],
    ]);

    const baseline = extractBaseline(grouped, "abc");
    const entry = baseline.evals["empty/eval"];
    if (!entry) throw new Error("expected entry for empty/eval");
    expect(entry.pass).toBe(true);
    expect(entry.scores).toEqual({});
    expect(entry.toolCalls).toEqual([]);
    expect(entry.turns).toBe(0);
    expect(entry.error).toBeNull();
  });
});
