/**
 * MCP tool for running FSM test suites
 */

import { stringifyError } from "@atlas/utils";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getDocumentStore } from "../../document-store/node.ts";
import { TestRunner } from "./lib/runner.ts";
import { TestSuiteSchema } from "./lib/schema.ts";
import { createErrorResponse, createSuccessResponse } from "./utils.ts";

const RunTestSuiteInputSchema = z.object({
  suite: TestSuiteSchema.describe("Test suite with multiple tests to execute"),
});

/**
 * Register the fsm_test_suite_run tool
 *
 * Executes a test suite with multiple tests and returns aggregated results.
 */
export function registerFSMTestSuiteRunTool(server: McpServer) {
  server.registerTool(
    "fsm_test_suite_run",
    {
      description: `Run a test suite containing multiple FSM tests.

Executes all tests in the suite sequentially and returns aggregated results including:
- name: Suite name
- results: Array of individual test results
- total: Total number of tests
- passed: Number of passed tests
- failed: Number of failed tests
- totalTime: Total execution time in milliseconds

Example input:
{
  "name": "Order Processing Tests",
  "tests": [
    {
      "name": "Test approval",
      "fsm": {...},
      "setup": {...},
      "signal": {...},
      "assertions": {...}
    },
    {
      "name": "Test rejection",
      "fsm": {...},
      "setup": {...},
      "signal": {...},
      "assertions": {...}
    }
  ]
}

Example output:
{
  "name": "Order Processing Tests",
  "total": 2,
  "passed": 2,
  "failed": 0,
  "totalTime": 42.5,
  "results": [
    {
      "name": "Test approval",
      "passed": true,
      "errors": [],
      ...
    },
    {
      "name": "Test rejection",
      "passed": true,
      "errors": [],
      ...
    }
  ]
}`,
      inputSchema: TestSuiteSchema.shape,
    },
    async (args: unknown) => {
      try {
        const parsed = RunTestSuiteInputSchema.parse({ suite: args });
        const suite = parsed.suite;

        // Create test runner against a per-invocation scope so the
        // suite's writes don't pollute (or get polluted by) any real
        // workspace document state in the shared JetStream store.
        const runner = new TestRunner(getDocumentStore(), {
          workspaceId: `fsm-test-${crypto.randomUUID()}`,
          sessionId: `fsm-test-session-${crypto.randomUUID()}`,
        });

        // Run the test suite
        const result = await runner.runSuite(suite);

        return createSuccessResponse({
          success: true,
          result: {
            name: result.name,
            total: result.total,
            passed: result.passed,
            failed: result.failed,
            totalTime: result.totalTime,
            results: result.results.map((r) => ({
              name: r.name,
              description: r.description,
              passed: r.passed,
              errors: r.errors,
              actualState: r.actualState,
              executionTime: r.executionTime,
            })),
          },
        });
      } catch (error) {
        return createErrorResponse("Failed to run test suite", stringifyError(error));
      }
    },
  );
}
