/**
 * MCP tool for creating FSM definitions programmatically
 */

import { stringifyError } from "@atlas/utils";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { FSMDefinitionSchema } from "../schema.ts";
import { createErrorResponse, createSuccessResponse } from "./utils.ts";

const CreateFSMInputSchema = z.object({
  definition: FSMDefinitionSchema.describe(
    "Complete FSM definition with id, initial state, states, functions, tools, and documentTypes",
  ),
});

/**
 * Register the fsm_create tool
 *
 * Creates a validated FSM definition from a complete specification with code-based guards and actions.
 * Returns the validated FSM definition ready for instantiation.
 */
export function registerFSMCreateTool(server: McpServer) {
  server.registerTool(
    "fsm_create",
    {
      description: `Create a finite state machine definition with TypeScript code for guards and actions.

An FSM definition consists of:
- id: Unique identifier
- initial: Initial state name
- states: Map of state definitions with documents, entry actions, and transitions
- functions: Map of guard and action functions (TypeScript code)
- tools: Map of tool functions that LLMs can call (TypeScript code)
- documentTypes: JSON Schema definitions for document validation

Functions are TypeScript code strings that will be executed via dynamic import:
- Guards: Functions that return boolean to control transitions
  function hasInventory(context, event) {
    const order = context.documents.find(d => d.id === 'order');
    return order.data.items.length > 0;
  }

- Actions: Functions that modify state and documents
  function validateOrder(context, event, updateDoc) {
    const order = context.documents.find(d => d.id === 'order');
    updateDoc(order.id, { status: 'validated' });
  }

States have:
- documents: Array of { id, type, data } for initial document setup
- entry: Array of actions executed when entering state
- on: Map of event name to transition(s)
- type: "final" for terminal states

Transitions have:
- target: Destination state name
- guards: Array of guard function names (all must pass)
- actions: Array of actions (code, llm, agent, emit)

Actions types:
- code: Execute TypeScript function
  { type: "code", function: "validateOrder" }

- emit: Emit an event
  { type: "emit", event: "order.approved", data: {...} }

- llm: Call LLM with context
  { type: "llm", provider: "anthropic", model: "claude-3-5-sonnet", prompt: "...", tools: [...], outputTo: "result" }

- agent: Invoke Atlas agent
  { type: "agent", agentId: "weather-fetcher", outputTo: "weather" }

Example:
{
  "id": "order-processor",
  "initial": "pending",
  "documentTypes": {
    "Order": {
      "type": "object",
      "properties": {
        "total": { "type": "number", "minimum": 0 },
        "status": { "type": "string" }
      },
      "required": ["total", "status"]
    }
  },
  "functions": {
    "hasMinimumTotal": {
      "type": "guard",
      "code": "export default function(context, event) { const order = context.documents[0]; return order.data.total >= 100; }"
    },
    "updateStatus": {
      "type": "action",
      "code": "export default function(context, event, updateDoc) { const order = context.documents[0]; updateDoc(order.id, { status: 'approved' }); }"
    }
  },
  "states": {
    "pending": {
      "documents": [
        { "id": "order", "type": "Order", "data": { "total": 150, "status": "pending" } }
      ],
      "on": {
        "APPROVE": {
          "target": "approved",
          "guards": ["hasMinimumTotal"],
          "actions": [
            { "type": "code", "function": "updateStatus" },
            { "type": "emit", "event": "order.approved" }
          ]
        }
      }
    },
    "approved": {
      "type": "final"
    }
  }
}`,
      inputSchema: CreateFSMInputSchema.shape.definition.shape,
    },
    (args: unknown) => {
      try {
        const parsed = CreateFSMInputSchema.parse({ definition: args });
        const definition = parsed.definition;

        // Validation is done by Zod schema
        return createSuccessResponse({
          success: true,
          fsm: definition,
          summary: {
            id: definition.id,
            initial: definition.initial,
            stateCount: Object.keys(definition.states).length,
            functionCount: definition.functions ? Object.keys(definition.functions).length : 0,
            toolCount: definition.tools ? Object.keys(definition.tools).length : 0,
            documentTypeCount: definition.documentTypes
              ? Object.keys(definition.documentTypes).length
              : 0,
          },
        });
      } catch (error) {
        return createErrorResponse("Failed to create FSM definition", stringifyError(error));
      }
    },
  );
}
