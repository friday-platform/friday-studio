/**
 * Test runner for FSM transition validation
 */

import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { logger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";
import type { DocumentScope, DocumentStore } from "../../../document-store/mod.ts";
import { FSMDocumentDataSchema } from "../../document-schemas.ts";
import { FSMEngine } from "../../fsm-engine.ts";
import type { Document, EmittedEvent } from "../../types.ts";
import { TestDefinitionSchema } from "./schema.ts";
import type { TestDefinition, TestResult, TestSuite, TestSuiteResult } from "./types.ts";

/**
 * Deep partial match - checks if expected object is subset of actual
 */
function matchesPartial(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
): boolean {
  for (const [key, expectedValue] of Object.entries(expected)) {
    const actualValue = actual[key];

    if (expectedValue === undefined) continue;

    if (
      typeof expectedValue === "object" &&
      expectedValue !== null &&
      !Array.isArray(expectedValue)
    ) {
      if (typeof actualValue !== "object" || actualValue === null) return false;
      if (
        !matchesPartial(
          actualValue as Record<string, unknown>,
          expectedValue as Record<string, unknown>,
        )
      ) {
        return false;
      }
    } else if (Array.isArray(expectedValue)) {
      if (!Array.isArray(actualValue)) return false;
      if (actualValue.length !== expectedValue.length) return false;
      for (let i = 0; i < expectedValue.length; i++) {
        if (typeof expectedValue[i] === "object" && expectedValue[i] !== null) {
          if (
            !matchesPartial(
              actualValue[i] as Record<string, unknown>,
              expectedValue[i] as Record<string, unknown>,
            )
          ) {
            return false;
          }
        } else if (actualValue[i] !== expectedValue[i]) {
          return false;
        }
      }
    } else {
      if (actualValue !== expectedValue) return false;
    }
  }
  return true;
}

/**
 * Run a custom validation function
 */
async function runCustomValidation(
  code: string,
  actualState: string,
  actualDocuments: Document[],
  actualEvents: EmittedEvent[],
): Promise<{ passed: boolean; error?: string }> {
  const tempFile = await Deno.makeTempFile({ suffix: ".ts" });
  try {
    await writeFile(tempFile, code, "utf-8");
    const module = await import(/* @vite-ignore */ `file://${tempFile}`);
    const validate = module.validate ?? module.default;

    if (!validate || typeof validate !== "function") {
      return { passed: false, error: "Custom validation must export a 'validate' function" };
    }

    const result = await validate({
      state: actualState,
      documents: actualDocuments,
      events: actualEvents,
    });

    if (typeof result === "boolean") {
      return { passed: result };
    } else if (typeof result === "object" && result !== null) {
      return { passed: result.passed ?? false, error: result.error };
    } else {
      return {
        passed: false,
        error: "Validation function must return boolean or {passed, error?}",
      };
    }
  } catch (error) {
    return { passed: false, error: `Custom validation error: ${stringifyError(error)}` };
  } finally {
    await rm(tempFile).catch(() => {});
  }
}

export class TestRunner {
  constructor(
    private documentStore: DocumentStore,
    private scope: DocumentScope,
  ) {}

  /**
   * Run a single test
   */
  async runTest(test: TestDefinition): Promise<TestResult> {
    const startTime = performance.now();
    const errors: string[] = [];

    try {
      // Validate test definition
      TestDefinitionSchema.parse(test);

      // Create FSM engine
      const engine = new FSMEngine(test.fsm, {
        documentStore: this.documentStore,
        scope: this.scope,
      });

      // Override initial state if setup specifies different state
      if (test.setup.state !== test.fsm.initial) {
        // Write state to store to be picked up by initialize()
        const stateResult = await this.documentStore.saveState(this.scope, test.fsm.id, {
          state: test.setup.state,
        });
        if (!stateResult.ok) {
          throw new Error(`Failed to save test state: ${stateResult.error}`);
        }
      }

      // Set up initial documents by writing them to the store first
      if (test.setup.documents) {
        for (const doc of test.setup.documents) {
          const writeResult = await this.documentStore.write(
            this.scope,
            test.fsm.id,
            doc.id,
            { type: doc.type, data: doc.data },
            FSMDocumentDataSchema,
          );
          if (!writeResult.ok) {
            throw new Error(`Failed to write test document ${doc.id}: ${writeResult.error}`);
          }
        }
      }

      // Initialize engine (will load documents from store)
      await engine.initialize();

      // Send signal — pass a context with a fresh sessionId so that
      // WorkspaceRuntime.executeAgent (runtime.ts:1007) does not throw
      // "Missing sessionId in signal context". Production paths always
      // supply context via processSignalForJob; the test runner must too.
      await engine.signal(test.signal, {
        sessionId: randomUUID(),
        workspaceId: this.scope.workspaceId,
      });

      // Get actual results
      const actualState = engine.state;
      const actualDocuments = engine.documents;
      const actualEvents = engine.emittedEvents;

      // Validate state
      if (actualState !== test.assertions.state) {
        errors.push(`State mismatch: expected "${test.assertions.state}", got "${actualState}"`);
      }

      // Validate documents
      if (test.assertions.documents) {
        for (const expectedDoc of test.assertions.documents) {
          const actualDoc = actualDocuments.find((d) => d.id === expectedDoc.id);

          if (!actualDoc) {
            errors.push(`Document "${expectedDoc.id}" not found`);
            continue;
          }

          if (expectedDoc.data && !matchesPartial(actualDoc.data, expectedDoc.data)) {
            errors.push(
              `Document "${expectedDoc.id}" data mismatch:\nExpected: ${JSON.stringify(
                expectedDoc.data,
                null,
                2,
              )}\nActual: ${JSON.stringify(actualDoc.data, null, 2)}`,
            );
          }
        }
      }

      // Validate emitted events
      if (test.assertions.emittedEvents) {
        if (actualEvents.length !== test.assertions.emittedEvents.length) {
          errors.push(
            `Event count mismatch: expected ${test.assertions.emittedEvents.length}, got ${actualEvents.length}`,
          );
        } else {
          for (let i = 0; i < test.assertions.emittedEvents.length; i++) {
            const expected = test.assertions.emittedEvents[i];
            const actual = actualEvents[i];

            if (!expected || !actual) continue;

            if (actual.event !== expected.event) {
              errors.push(
                `Event ${i} mismatch: expected "${expected.event}", got "${actual.event}"`,
              );
            }

            if (expected.data && actual.data && !matchesPartial(actual.data, expected.data)) {
              errors.push(
                `Event ${i} data mismatch:\nExpected: ${JSON.stringify(
                  expected.data,
                  null,
                  2,
                )}\nActual: ${JSON.stringify(actual.data, null, 2)}`,
              );
            }
          }
        }
      }

      // Run custom validation if provided
      if (test.assertions.custom) {
        const customResult = await runCustomValidation(
          test.assertions.custom,
          actualState,
          actualDocuments,
          actualEvents,
        );

        if (!customResult.passed) {
          errors.push(customResult.error ?? "Custom validation failed");
        }
      }

      const executionTime = performance.now() - startTime;

      return {
        name: test.name,
        description: test.description,
        passed: errors.length === 0,
        errors,
        actualState,
        actualDocuments,
        actualEvents,
        executionTime,
      };
    } catch (error) {
      const executionTime = performance.now() - startTime;
      const errorMessage = stringifyError(error);
      logger.error(`Test "${test.name}" threw exception`, { error: errorMessage });

      return {
        name: test.name,
        description: test.description,
        passed: false,
        errors: [`Test execution failed: ${errorMessage}`],
        actualState: "",
        actualDocuments: [],
        actualEvents: [],
        executionTime,
      };
    }
  }

  /**
   * Run a test suite
   */
  async runSuite(suite: TestSuite): Promise<TestSuiteResult> {
    const startTime = performance.now();
    const results: TestResult[] = [];

    for (const test of suite.tests) {
      const result = await this.runTest(test);
      results.push(result);
    }

    const totalTime = performance.now() - startTime;
    const passed = results.filter((r) => r.passed).length;
    const failed = results.filter((r) => !r.passed).length;

    return { name: suite.name, results, total: results.length, passed, failed, totalTime };
  }
}
