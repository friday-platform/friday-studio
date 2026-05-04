/**
 * MCP tool for running FSM tests
 */

import { stringifyError } from "@atlas/utils";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getDocumentStore } from "../../document-store/mod.ts";
import { TestRunner } from "./lib/runner.ts";
import { TestDefinitionSchema } from "./lib/schema.ts";
import { createErrorResponse, createSuccessResponse } from "./utils.ts";

const RunTestInputSchema = z.object({
  test: TestDefinitionSchema.describe("Test definition to execute"),
});

/**
 * Register the fsm_test_run tool
 *
 * Executes a test definition and returns validation results.
 */
export function registerFSMTestRunTool(server: McpServer) {
  server.registerTool(
    "fsm_test_run",
    {
      description: `Run a test definition to validate FSM state transitions.

Executes the test by:
1. Creating FSM engine with initial state and documents
2. Sending the specified signal
3. Validating final state, documents, and events match assertions

Returns detailed test results including:
- passed: Whether test passed
- errors: Array of validation errors if any
- actualState: Final state after signal processing
- actualDocuments: Final documents after signal processing
- actualEvents: Events emitted during transition
- executionTime: Test execution time in milliseconds

Example input:
{
  "name": "Test order approval",
  "fsm": {...},
  "setup": {
    "state": "pending",
    "documents": [{"id": "order", "data": {"items": ["laptop"]}}]
  },
  "signal": {"type": "APPROVE"},
  "assertions": {
    "state": "approved",
    "documents": [{"id": "order", "data": {"status": "validated"}}]
  }
}

Example output:
{
  "passed": true,
  "errors": [],
  "actualState": "approved",
  "actualDocuments": [...],
  "actualEvents": [...],
  "executionTime": 15.3
}`,
      inputSchema: TestDefinitionSchema.shape,
    },
    async (args: unknown) => {
      try {
        const parsed = RunTestInputSchema.parse({ test: args });
        const test = parsed.test;

        // Create test runner against a per-invocation scope so the
        // run's writes don't pollute (or get polluted by) any real
        // workspace document state in the shared JetStream store.
        const runner = new TestRunner(getDocumentStore(), {
          workspaceId: `fsm-test-${crypto.randomUUID()}`,
          sessionId: `fsm-test-session-${crypto.randomUUID()}`,
        });

        // Run the test
        const result = await runner.runTest(test);

        return createSuccessResponse({
          success: true,
          result: {
            name: result.name,
            description: result.description,
            passed: result.passed,
            errors: result.errors,
            actualState: result.actualState,
            actualDocuments: result.actualDocuments,
            actualEvents: result.actualEvents,
            executionTime: result.executionTime,
          },
        });
      } catch (error) {
        return createErrorResponse("Failed to run test", stringifyError(error));
      }
    },
  );
}
