import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type EvalResult, EvalResultSchema, readOutputDir, writeEvalResult } from "./output.ts";

const TEST_OUTPUT_DIR = join(import.meta.dirname ?? ".", "__test_output__");

function cleanup() {
  if (existsSync(TEST_OUTPUT_DIR)) {
    rmSync(TEST_OUTPUT_DIR, { recursive: true });
  }
}

describe("writeEvalResult", () => {
  beforeEach(() => cleanup());
  afterEach(() => cleanup());

  it("creates file with correct JSON structure", async () => {
    const result: EvalResult = {
      evalName: "data-analyst/simple-query",
      scores: [{ name: "accuracy", value: 0.9 }],
      traces: [],
      metadata: { model: "claude-sonnet" },
      timestamp: "2026-02-17T10:30:00.000Z",
    };

    const filepath = await writeEvalResult(result, TEST_OUTPUT_DIR);
    const content = EvalResultSchema.parse(JSON.parse(readFileSync(filepath, "utf-8")));

    expect(content).toMatchObject({
      evalName: "data-analyst/simple-query",
      scores: [{ name: "accuracy", value: 0.9 }],
      traces: [],
      metadata: { model: "claude-sonnet" },
      timestamp: "2026-02-17T10:30:00.000Z",
    });
  });

  it("creates nested directories for eval name with slashes", async () => {
    const result: EvalResult = {
      evalName: "agents/data-analyst/grouped-query",
      scores: [],
      traces: [],
      metadata: {},
      timestamp: "2026-02-17T11:00:00.000Z",
    };

    const filepath = await writeEvalResult(result, TEST_OUTPUT_DIR);

    expect(existsSync(filepath)).toBe(true);
    const expectedPrefix = join(TEST_OUTPUT_DIR, "agents", "data-analyst", "grouped-query");
    expect(filepath).toContain(expectedPrefix);
  });

  it("uses ISO timestamp in filename", async () => {
    const result: EvalResult = {
      evalName: "test-eval",
      scores: [],
      traces: [],
      metadata: {},
      timestamp: "2026-02-17T10:30:00.000Z",
    };

    const filepath = await writeEvalResult(result, TEST_OUTPUT_DIR);

    expect(filepath).toContain("2026-02-17");
    expect(filepath).toMatch(/\.json$/);
  });
});

/** Helper to write a minimal valid EvalResult for read tests. */
function makeResult(
  overrides: Partial<EvalResult> & Pick<EvalResult, "evalName" | "timestamp">,
): EvalResult {
  return { scores: [], traces: [], metadata: {}, ...overrides };
}

describe("readOutputDir", () => {
  beforeEach(() => cleanup());
  afterEach(() => cleanup());

  it("reads and groups results by evalName, sorted by timestamp", async () => {
    const older = makeResult({ evalName: "agent/test", timestamp: "2026-02-17T10:00:00.000Z" });
    const newer = makeResult({ evalName: "agent/test", timestamp: "2026-02-17T11:00:00.000Z" });
    const other = makeResult({ evalName: "agent/other", timestamp: "2026-02-17T09:00:00.000Z" });

    await writeEvalResult(older, TEST_OUTPUT_DIR);
    await writeEvalResult(newer, TEST_OUTPUT_DIR);
    await writeEvalResult(other, TEST_OUTPUT_DIR);

    const results = await readOutputDir({ outputDir: TEST_OUTPUT_DIR });

    expect(results.size).toBe(2);

    const testResults = results.get("agent/test");
    expect.assert(testResults !== undefined);
    expect(testResults).toHaveLength(2);
    expect(testResults.map((r) => r.timestamp)).toEqual([
      "2026-02-17T10:00:00.000Z",
      "2026-02-17T11:00:00.000Z",
    ]);

    expect(results.get("agent/other")).toHaveLength(1);
  });

  it("returns empty map for nonexistent directory", async () => {
    const results = await readOutputDir({ outputDir: join(TEST_OUTPUT_DIR, "nope") });
    expect(results.size).toBe(0);
  });

  it("filters to latest result per evalName", async () => {
    const older = makeResult({ evalName: "agent/test", timestamp: "2026-02-17T10:00:00.000Z" });
    const newer = makeResult({ evalName: "agent/test", timestamp: "2026-02-17T11:00:00.000Z" });

    await writeEvalResult(older, TEST_OUTPUT_DIR);
    await writeEvalResult(newer, TEST_OUTPUT_DIR);

    const results = await readOutputDir({ outputDir: TEST_OUTPUT_DIR, latest: true });

    const testResults = results.get("agent/test");
    expect.assert(testResults !== undefined);
    expect(testResults).toHaveLength(1);
    expect(testResults.map((r) => r.timestamp)).toEqual(["2026-02-17T11:00:00.000Z"]);
  });

  it("filters by evalName substring", async () => {
    const a = makeResult({ evalName: "data-analyst/query", timestamp: "2026-02-17T10:00:00.000Z" });
    const b = makeResult({ evalName: "slack/post", timestamp: "2026-02-17T10:00:00.000Z" });

    await writeEvalResult(a, TEST_OUTPUT_DIR);
    await writeEvalResult(b, TEST_OUTPUT_DIR);

    const results = await readOutputDir({ outputDir: TEST_OUTPUT_DIR, evalName: "data-analyst" });

    expect(results.size).toBe(1);
    expect(results.has("data-analyst/query")).toBe(true);
  });

  it("filters by runId", async () => {
    const a = makeResult({
      evalName: "test",
      timestamp: "2026-02-17T10:00:00.000Z",
      runId: "run-1",
    });
    const b = makeResult({
      evalName: "test",
      timestamp: "2026-02-17T11:00:00.000Z",
      runId: "run-2",
    });

    await writeEvalResult(a, TEST_OUTPUT_DIR);
    await writeEvalResult(b, TEST_OUTPUT_DIR);

    const results = await readOutputDir({ outputDir: TEST_OUTPUT_DIR, runId: "run-1" });

    const testResults = results.get("test");
    expect.assert(testResults !== undefined);
    expect(testResults).toHaveLength(1);
    expect(testResults.map((r) => r.runId)).toEqual(["run-1"]);
  });

  it("skips malformed JSON files without crashing", async () => {
    const valid = makeResult({ evalName: "good-eval", timestamp: "2026-02-17T10:00:00.000Z" });
    await writeEvalResult(valid, TEST_OUTPUT_DIR);

    const badDir = join(TEST_OUTPUT_DIR, "bad-eval");
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, "broken.json"), "not valid json", "utf-8");

    const results = await readOutputDir({ outputDir: TEST_OUTPUT_DIR });

    expect(results.size).toBe(1);
    expect(results.has("good-eval")).toBe(true);
  });

  it("filters by tag", async () => {
    const tagged = makeResult({
      evalName: "test",
      timestamp: "2026-02-17T10:00:00.000Z",
      tag: "experiment-1",
    });
    const untagged = makeResult({ evalName: "test", timestamp: "2026-02-17T11:00:00.000Z" });
    const otherTag = makeResult({
      evalName: "test",
      timestamp: "2026-02-17T12:00:00.000Z",
      tag: "experiment-2",
    });

    await writeEvalResult(tagged, TEST_OUTPUT_DIR);
    await writeEvalResult(untagged, TEST_OUTPUT_DIR);
    await writeEvalResult(otherTag, TEST_OUTPUT_DIR);

    const results = await readOutputDir({ outputDir: TEST_OUTPUT_DIR, tag: "experiment-1" });

    const testResults = results.get("test");
    expect.assert(testResults !== undefined);
    expect(testResults).toHaveLength(1);
    expect(testResults[0]?.tag).toBe("experiment-1");
  });

  it("skips files that fail schema validation without crashing", async () => {
    const valid = makeResult({ evalName: "good-eval", timestamp: "2026-02-17T10:00:00.000Z" });
    await writeEvalResult(valid, TEST_OUTPUT_DIR);

    const badDir = join(TEST_OUTPUT_DIR, "schema-fail");
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, "wrong-shape.json"), JSON.stringify({ foo: "bar" }), "utf-8");

    const results = await readOutputDir({ outputDir: TEST_OUTPUT_DIR });

    expect(results.size).toBe(1);
    expect(results.has("good-eval")).toBe(true);
  });
});
