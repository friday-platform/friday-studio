import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EvalResult } from "./output.ts";
import { executeEvals } from "./runner.ts";

const TEST_DIR = join(import.meta.dirname ?? ".", "__test_runner__");
const TEST_OUTPUT_DIR = join(TEST_DIR, "__output__");

function cleanup() {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
}

/** Writes a synthetic eval module that exports `evals`. */
function writeEvalFile(filename: string, content: string): string {
  const filepath = join(TEST_DIR, filename);
  mkdirSync(join(TEST_DIR), { recursive: true });
  writeFileSync(filepath, content, "utf-8");
  return filepath;
}

/** Asserts result exists at index and returns it. */
function resultAt(results: EvalResult[], index: number): EvalResult {
  const r = results[index];
  if (!r)
    throw new Error(`expected result at index ${index}, got undefined (length: ${results.length})`);
  return r;
}

describe("executeEvals", () => {
  beforeEach(() => cleanup());
  afterEach(() => cleanup());

  it("imports file, reads .evals export, executes, and collects results", async () => {
    const filepath = writeEvalFile(
      "good.eval.ts",
      `
import { AgentContextAdapter } from "${join(import.meta.dirname ?? ".", "context.ts")}";

const adapter = new AgentContextAdapter();

export const evals = [
  {
    name: "test-runner/good",
    adapter,
    config: {
      input: "hello",
      run: (input) => ({ echo: input }),
      outputDir: "${TEST_OUTPUT_DIR}",
    },
  },
];
`,
    );

    const results = await executeEvals([filepath]);
    expect(results).toHaveLength(1);

    const result = resultAt(results, 0);
    expect(result.evalName).toBe("test-runner/good");
    expect(result.metadata).toMatchObject({ input: "hello", result: { echo: "hello" } });
    expect(result.metadata).not.toHaveProperty("error");
  });

  it("continues to next eval when one throws", async () => {
    const filepath = writeEvalFile(
      "mixed.eval.ts",
      `
import { AgentContextAdapter } from "${join(import.meta.dirname ?? ".", "context.ts")}";

const adapter = new AgentContextAdapter();

export const evals = [
  {
    name: "test-runner/fail",
    adapter,
    config: {
      input: "boom",
      run: () => { throw new Error("kaboom"); },
      outputDir: "${TEST_OUTPUT_DIR}",
    },
  },
  {
    name: "test-runner/pass",
    adapter,
    config: {
      input: "ok",
      run: (input) => input,
      outputDir: "${TEST_OUTPUT_DIR}",
    },
  },
];
`,
    );

    const results = await executeEvals([filepath]);
    expect(results).toHaveLength(2);

    const failed = resultAt(results, 0);
    expect(failed.evalName).toBe("test-runner/fail");
    expect(failed.metadata).toHaveProperty("error");
    expect(failed.metadata.error).toMatchObject({ phase: "execution" });

    const passed = resultAt(results, 1);
    expect(passed.evalName).toBe("test-runner/pass");
    expect(passed.metadata).not.toHaveProperty("error");
  });

  it("records error for file with no .evals export", async () => {
    const filepath = writeEvalFile("no-export.eval.ts", `export const something = "not evals";`);

    const results = await executeEvals([filepath]);
    expect(results).toHaveLength(1);

    const result = resultAt(results, 0);
    expect(result.evalName).toContain("no-export.eval.ts");
    expect(result.metadata).toHaveProperty("error");
    expect(result.metadata.error).toMatchObject({ phase: "import" });
  });

  it("records error for file with non-array .evals export", async () => {
    const filepath = writeEvalFile("bad-export.eval.ts", `export const evals = "not an array";`);

    const results = await executeEvals([filepath]);
    expect(results).toHaveLength(1);

    const result = resultAt(results, 0);
    expect(result.evalName).toContain("bad-export.eval.ts");
    expect(result.metadata).toHaveProperty("error");
    expect(result.metadata.error).toMatchObject({ phase: "import" });
  });

  it("records error for file that fails to import", async () => {
    const filepath = join(TEST_DIR, "missing.eval.ts");

    const results = await executeEvals([filepath]);
    expect(results).toHaveLength(1);

    const result = resultAt(results, 0);
    expect(result.metadata).toHaveProperty("error");
    expect(result.metadata.error).toMatchObject({ phase: "import" });
  });

  it("handles multiple files", async () => {
    const file1 = writeEvalFile(
      "a.eval.ts",
      `
import { AgentContextAdapter } from "${join(import.meta.dirname ?? ".", "context.ts")}";
const adapter = new AgentContextAdapter();
export const evals = [{
  name: "test-runner/a",
  adapter,
  config: { input: "a", run: () => "a", outputDir: "${TEST_OUTPUT_DIR}" },
}];
`,
    );
    const file2 = writeEvalFile(
      "b.eval.ts",
      `
import { AgentContextAdapter } from "${join(import.meta.dirname ?? ".", "context.ts")}";
const adapter = new AgentContextAdapter();
export const evals = [{
  name: "test-runner/b",
  adapter,
  config: { input: "b", run: () => "b", outputDir: "${TEST_OUTPUT_DIR}" },
}];
`,
    );

    const results = await executeEvals([file1, file2]);
    expect(results).toHaveLength(2);

    const first = resultAt(results, 0);
    const second = resultAt(results, 1);
    expect(first.evalName).toBe("test-runner/a");
    expect(second.evalName).toBe("test-runner/b");
  });

  it("--fail-fast stops after first failure", async () => {
    const filepath = writeEvalFile(
      "failfast.eval.ts",
      `
import { AgentContextAdapter } from "${join(import.meta.dirname ?? ".", "context.ts")}";
const adapter = new AgentContextAdapter();
export const evals = [
  {
    name: "test-runner/first-fail",
    adapter,
    config: { input: "boom", run: () => { throw new Error("kaboom"); }, outputDir: "${TEST_OUTPUT_DIR}" },
  },
  {
    name: "test-runner/never-runs",
    adapter,
    config: { input: "ok", run: () => "ok", outputDir: "${TEST_OUTPUT_DIR}" },
  },
];
`,
    );

    const results = await executeEvals([filepath], { failFast: true });
    expect(results).toHaveLength(1);

    const result = resultAt(results, 0);
    expect(result.evalName).toBe("test-runner/first-fail");
    expect(result.metadata).toHaveProperty("error");
  });

  it("--fail-fast stops across files", async () => {
    const file1 = writeEvalFile(
      "ff-fail.eval.ts",
      `
import { AgentContextAdapter } from "${join(import.meta.dirname ?? ".", "context.ts")}";
const adapter = new AgentContextAdapter();
export const evals = [{
  name: "test-runner/ff-fail",
  adapter,
  config: { input: "boom", run: () => { throw new Error("kaboom"); }, outputDir: "${TEST_OUTPUT_DIR}" },
}];
`,
    );
    const file2 = writeEvalFile(
      "ff-pass.eval.ts",
      `
import { AgentContextAdapter } from "${join(import.meta.dirname ?? ".", "context.ts")}";
const adapter = new AgentContextAdapter();
export const evals = [{
  name: "test-runner/ff-pass",
  adapter,
  config: { input: "ok", run: () => "ok", outputDir: "${TEST_OUTPUT_DIR}" },
}];
`,
    );

    const results = await executeEvals([file1, file2], { failFast: true });
    expect(results).toHaveLength(1);
    expect(resultAt(results, 0).evalName).toBe("test-runner/ff-fail");
  });

  it("--filter runs only matching evals", async () => {
    const filepath = writeEvalFile(
      "filterable.eval.ts",
      `
import { AgentContextAdapter } from "${join(import.meta.dirname ?? ".", "context.ts")}";
const adapter = new AgentContextAdapter();
export const evals = [
  {
    name: "agent/refusal/prompt-injection",
    adapter,
    config: { input: "a", run: () => "a", outputDir: "${TEST_OUTPUT_DIR}" },
  },
  {
    name: "agent/happy-path/basic",
    adapter,
    config: { input: "b", run: () => "b", outputDir: "${TEST_OUTPUT_DIR}" },
  },
  {
    name: "agent/refusal/jailbreak",
    adapter,
    config: { input: "c", run: () => "c", outputDir: "${TEST_OUTPUT_DIR}" },
  },
];
`,
    );

    const results = await executeEvals([filepath], { filter: "refusal" });
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.evalName)).toEqual([
      "agent/refusal/prompt-injection",
      "agent/refusal/jailbreak",
    ]);
  });

  it("--filter is case-insensitive", async () => {
    const filepath = writeEvalFile(
      "case-filter.eval.ts",
      `
import { AgentContextAdapter } from "${join(import.meta.dirname ?? ".", "context.ts")}";
const adapter = new AgentContextAdapter();
export const evals = [
  {
    name: "DataAnalyst/Query",
    adapter,
    config: { input: "a", run: () => "a", outputDir: "${TEST_OUTPUT_DIR}" },
  },
  {
    name: "slack/post",
    adapter,
    config: { input: "b", run: () => "b", outputDir: "${TEST_OUTPUT_DIR}" },
  },
];
`,
    );

    const results = await executeEvals([filepath], { filter: "dataanalyst" });
    expect(results).toHaveLength(1);
    expect(resultAt(results, 0).evalName).toBe("DataAnalyst/Query");
  });

  it("preserves scores and metadata from failed evals (no data loss)", async () => {
    const filepath = writeEvalFile(
      "data-loss.eval.ts",
      `
import { AgentContextAdapter } from "${join(import.meta.dirname ?? ".", "context.ts")}";

const adapter = new AgentContextAdapter();

export const evals = [
  {
    name: "test-runner/assertion-fail-with-scores",
    adapter,
    config: {
      input: "hello",
      run: (input) => ({ response: input }),
      assert: () => { throw new Error("assertion failed"); },
      score: () => [{ name: "quality", value: 0.9, reason: "good" }],
      outputDir: "${TEST_OUTPUT_DIR}",
    },
  },
];
`,
    );

    const results = await executeEvals([filepath]);
    expect(results).toHaveLength(1);

    const result = resultAt(results, 0);
    expect(result.evalName).toBe("test-runner/assertion-fail-with-scores");
    // Must have error metadata
    expect(result.metadata).toHaveProperty("error");
    expect(result.metadata.error).toMatchObject({ phase: "assertion" });
    // Must preserve scores — not empty arrays from makeEvalErrorResult
    expect(result.scores).toMatchObject([{ name: "quality", value: 0.9 }]);
    // Must preserve the run result in metadata
    expect(result.metadata).toHaveProperty("result");
  });

  it("--tag stores tag on all results", async () => {
    const filepath = writeEvalFile(
      "tagged.eval.ts",
      `
import { AgentContextAdapter } from "${join(import.meta.dirname ?? ".", "context.ts")}";
const adapter = new AgentContextAdapter();
export const evals = [
  {
    name: "test-runner/tagged-a",
    adapter,
    config: { input: "a", run: () => "a", outputDir: "${TEST_OUTPUT_DIR}" },
  },
  {
    name: "test-runner/tagged-b",
    adapter,
    config: { input: "b", run: () => "b", outputDir: "${TEST_OUTPUT_DIR}" },
  },
];
`,
    );

    const results = await executeEvals([filepath], { tag: "baseline" });
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.tag === "baseline")).toBe(true);
  });

  it("--tag stores tag on import-error results", async () => {
    const filepath = join(TEST_DIR, "missing-tagged.eval.ts");

    const results = await executeEvals([filepath], { tag: "experiment-1" });
    expect(results).toHaveLength(1);

    const result = resultAt(results, 0);
    expect(result.metadata.error).toMatchObject({ phase: "import" });
    expect(result.tag).toBe("experiment-1");
  });

  it("omits tag when --tag not provided", async () => {
    const filepath = writeEvalFile(
      "no-tag.eval.ts",
      `
import { AgentContextAdapter } from "${join(import.meta.dirname ?? ".", "context.ts")}";
const adapter = new AgentContextAdapter();
export const evals = [{
  name: "test-runner/no-tag",
  adapter,
  config: { input: "a", run: () => "a", outputDir: "${TEST_OUTPUT_DIR}" },
}];
`,
    );

    const results = await executeEvals([filepath]);
    expect(results).toHaveLength(1);
    expect(resultAt(results, 0).tag).toBeUndefined();
  });

  it("--filter with no matches returns empty results", async () => {
    const filepath = writeEvalFile(
      "no-match.eval.ts",
      `
import { AgentContextAdapter } from "${join(import.meta.dirname ?? ".", "context.ts")}";
const adapter = new AgentContextAdapter();
export const evals = [{
  name: "test-runner/something",
  adapter,
  config: { input: "a", run: () => "a", outputDir: "${TEST_OUTPUT_DIR}" },
}];
`,
    );

    const results = await executeEvals([filepath], { filter: "nonexistent" });
    expect(results).toHaveLength(0);
  });
});
