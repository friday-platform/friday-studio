import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentContextAdapter } from "./context.ts";
import { EvalResultSchema } from "./output.ts";
import { runEval } from "./run-eval.ts";

const TEST_OUTPUT_DIR = join(import.meta.dirname ?? ".", "__test_output__");

function cleanup() {
  if (existsSync(TEST_OUTPUT_DIR)) {
    rmSync(TEST_OUTPUT_DIR, { recursive: true });
  }
}

/** Reads the first JSON file from the eval output directory for a given eval name. */
function readOutput(evalName: string) {
  const dir = join(TEST_OUTPUT_DIR, ...evalName.split("/"));
  const files = readdirSync(dir, { withFileTypes: true });
  for (const f of files) {
    if (f.name.endsWith(".json")) {
      return EvalResultSchema.parse(JSON.parse(readFileSync(join(dir, f.name), "utf-8")));
    }
  }
  throw new Error(`No output file found for ${evalName}`);
}

describe("runEval", () => {
  beforeEach(() => cleanup());
  afterEach(() => cleanup());

  it("pass case writes result and returns it", async () => {
    const adapter = new AgentContextAdapter();

    const { result, error } = await runEval("test/pass-case", adapter, {
      input: "hello",
      run: (input) => ({ response: input.toUpperCase() }),
      metadata: { model: "mock" },
      outputDir: TEST_OUTPUT_DIR,
    });

    expect(error).toBeUndefined();
    expect(result).toMatchObject({
      evalName: "test/pass-case",
      scores: [],
      metadata: { input: "hello", result: { response: "HELLO" } },
    });
    expect(result.metadata).not.toHaveProperty("error");

    const written = readOutput("test/pass-case");
    expect(written.evalName).toBe("test/pass-case");
  });

  it("execution error returns result with error (no throw)", async () => {
    const adapter = new AgentContextAdapter();

    const { result, error } = await runEval("test/exec-error", adapter, {
      input: "boom",
      run: () => {
        throw new Error("agent exploded");
      },
      outputDir: TEST_OUTPUT_DIR,
    });

    expect(error).toBeDefined();
    expect(error?.message).toMatch(/\[execution\].*agent exploded/);
    expect(result).toMatchObject({
      evalName: "test/exec-error",
      scores: [],
      metadata: { error: { phase: "execution", message: "agent exploded" } },
    });

    const written = readOutput("test/exec-error");
    expect(written).toMatchObject({
      evalName: "test/exec-error",
      metadata: { error: { phase: "execution", message: "agent exploded" } },
    });
  });

  it("assertion error returns result with error and preserves run output", async () => {
    const adapter = new AgentContextAdapter();

    const { result, error } = await runEval("test/assert-error", adapter, {
      input: "test",
      run: () => ({ value: 42 }),
      assert: () => {
        throw new Error("expected 100");
      },
      outputDir: TEST_OUTPUT_DIR,
    });

    expect(error).toBeDefined();
    expect(error?.message).toMatch(/\[assertion\].*expected 100/);
    expect(result.metadata).toMatchObject({
      error: { phase: "assertion", message: "expected 100" },
      result: { value: 42 },
    });

    const written = readOutput("test/assert-error");
    expect(written.metadata).toMatchObject({
      error: { phase: "assertion", message: "expected 100" },
      result: { value: 42 },
    });
  });

  it("scorers produce scores in output", async () => {
    const adapter = new AgentContextAdapter();

    const { result } = await runEval("test/with-scores", adapter, {
      input: "score me",
      run: () => ({ quality: "good" }),
      score: () => [
        { name: "quality", value: 0.9, reason: "looks good" },
        { name: "speed", value: 0.7 },
      ],
      outputDir: TEST_OUTPUT_DIR,
    });

    expect(result.scores).toMatchObject([
      { name: "quality", value: 0.9 },
      { name: "speed", value: 0.7 },
    ]);
  });

  it("skips assert and score when execution fails", async () => {
    const adapter = new AgentContextAdapter();

    let assertCalled = false;
    let scoreCalled = false;

    const { error } = await runEval("test/skip-on-error", adapter, {
      input: "fail",
      run: () => {
        throw new Error("boom");
      },
      assert: () => {
        assertCalled = true;
      },
      score: () => {
        scoreCalled = true;
        return [{ name: "x", value: 1 }];
      },
      outputDir: TEST_OUTPUT_DIR,
    });

    expect(error).toBeDefined();
    expect(assertCalled).toBe(false);
    expect(scoreCalled).toBe(false);
  });

  it("assertion failure still runs scorer", async () => {
    const adapter = new AgentContextAdapter();

    let scoreCalled = false;

    const { result, error } = await runEval("test/assert-then-score", adapter, {
      input: "test",
      run: () => "result",
      assert: () => {
        throw new Error("assertion failed");
      },
      score: () => {
        scoreCalled = true;
        return [{ name: "s", value: 0.5 }];
      },
      outputDir: TEST_OUTPUT_DIR,
    });

    expect(error).toBeDefined();
    expect(scoreCalled).toBe(true);
    expect(result.scores).toMatchObject([{ name: "s", value: 0.5 }]);
  });

  it("context is passed to run callback", async () => {
    const adapter = new AgentContextAdapter({}, { API_KEY: "test-key" });

    await runEval("test/context-check", adapter, {
      input: "check context",
      run: (_input, context) => {
        expect(context.env.API_KEY).toBe("test-key");
        expect(context.session.workspaceId).toBe("eval-workspace");
        return "ok";
      },
      outputDir: TEST_OUTPUT_DIR,
    });
  });
});
