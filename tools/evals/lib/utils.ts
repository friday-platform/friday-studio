import { saveSnapshot } from "./snapshot.ts";

/**
 * Extracts the result from AI SDK tool execution.
 * Tool results can be either direct objects or async iterables - this unwraps both.
 */
export async function unwrapToolResult<T extends Record<string, unknown>>(
  result: T | AsyncIterable<T>,
): Promise<T> {
  if (result && Symbol.asyncIterator in result) {
    const results = [];
    for await (const chunk of result) {
      results.push(chunk);
    }
    const output = results.at(0);
    if (!output) throw new Error("No result found");
    return output;
  }
  return result;
}

interface TestSetupConfig {
  testFileUrl: URL;
}

/**
 * Creates test utilities that automatically snapshot step results.
 * Call once per test file, then use the returned `snapshot` function instead of `t.step`.
 *
 * @example
 * const { snapshot } = setupTest({ testFileUrl: new URL(import.meta.url) });
 * await snapshot(t, "test name", async ({ snapshot }) => {
 *   const result = computeResult();
 *   snapshot(result); // Snapshot before assertions to ensure snapshots have data
 *   assert(result.isValid, "Should be valid");
 *   return result;
 * });
 */
export function setupTest(config: TestSetupConfig) {
  return {
    step: async <T>(
      testContext: Deno.TestContext,
      stepName: string,
      stepFn: (ctx: { step: Deno.TestContext; snapshot: (result: T) => T }) => Promise<T>,
      getSnapshotData?: (result: T) => Record<string, unknown>,
    ): Promise<boolean> => {
      let capturedResult: T | undefined;
      let result: T | undefined;
      let pass = false;
      let error: Error | undefined;

      const capture = <R extends T | undefined>(r: R): R => {
        capturedResult = r;
        return r;
      };

      try {
        pass = await testContext.step(stepName, async (step) => {
          result = await stepFn({ step, snapshot: capture });
        });
      } catch (e) {
        error = e instanceof Error ? e : new Error(String(e));
      } finally {
        // Prefer explicitly captured snapshot over return value
        const finalResult = capturedResult ?? result;
        await saveSnapshot({
          testCase: stepName,
          testPath: config.testFileUrl,
          data:
            finalResult !== undefined
              ? getSnapshotData
                ? getSnapshotData(finalResult)
                : { result: finalResult }
              : error
                ? { error: error.message, stack: error.stack }
                : { error: "Step failed before producing result" },
          pass,
        });
      }

      return pass;
    },
  };
}
