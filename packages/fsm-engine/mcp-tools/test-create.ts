/**
 * MCP tool for creating FSM test definitions
 */

import { stringifyError } from "@atlas/utils";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TestDefinitionSchema } from "./lib/schema.ts";
import { createErrorResponse, createSuccessResponse } from "./utils.ts";

const CreateTestInputSchema = z.object({
  test: TestDefinitionSchema.describe(
    "Complete test definition with name, FSM, setup, signal, and assertions",
  ),
});

/**
 * Register the fsm_test_create tool
 *
 * Creates a validated test definition for FSM transition validation.
 * Returns the validated test definition ready for execution.
 */
export function registerFSMTestCreateTool(server: McpServer) {
  server.registerTool(
    "fsm_test_create",
    {
      description: `Create a test definition for validating FSM state transitions.

A test definition consists of:
- name: Test name
- description: Optional test description
- fsm: FSM definition to test
- setup: Initial state and documents
- signal: Signal to send
- assertions: Expected results

Setup:
- state: Initial state name
- documents: Optional array of initial documents

Assertions:
- state: Expected final state name
- documents: Optional array of expected documents (partial match)
- emittedEvents: Optional array of expected events
- custom: Optional custom validation function code

Example:
{
  "name": "Approve order with inventory",
  "description": "Test order approval when inventory is available",
  "fsm": {
    "id": "order-processor",
    "initial": "pending",
    "states": {
      "pending": {
        "on": {
          "APPROVE": {
            "target": "approved",
            "actions": [
              {"type": "code", "function": "validateOrder"}
            ]
          }
        }
      },
      "approved": {"type": "final"}
    },
    "functions": {
      "validateOrder": {
        "type": "action",
        "code": "export function validateOrder(context, event) { const order = context.documents.find(d => d.id === 'order'); order.data.status = 'validated'; }"
      }
    }
  },
  "setup": {
    "state": "pending",
    "documents": [
      {"id": "order", "data": {"items": ["laptop"], "total": 1200}}
    ]
  },
  "signal": {"type": "APPROVE", "data": {"approvedBy": "admin"}},
  "assertions": {
    "state": "approved",
    "documents": [
      {"id": "order", "data": {"status": "validated"}}
    ]
  }
}`,
      inputSchema: TestDefinitionSchema.shape,
    },
    (args: unknown) => {
      try {
        const parsed = CreateTestInputSchema.parse({ test: args });
        const test = parsed.test;

        return createSuccessResponse({
          success: true,
          test,
          summary: {
            name: test.name,
            fsmId: test.fsm.id,
            initialState: test.setup.state,
            signalType: test.signal.type,
            expectedState: test.assertions.state,
            documentAssertions: test.assertions.documents?.length ?? 0,
            eventAssertions: test.assertions.emittedEvents?.length ?? 0,
          },
        });
      } catch (error) {
        return createErrorResponse("Failed to create test definition", stringifyError(error));
      }
    },
  );
}
