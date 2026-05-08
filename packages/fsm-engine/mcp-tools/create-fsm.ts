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
    "Complete FSM definition with id, initial state, states, and documentTypes",
  ),
});

/**
 * Register the fsm_create tool
 *
 * Creates a validated FSM definition from a complete specification.
 * Returns the validated FSM definition ready for instantiation.
 */
export function registerFSMCreateTool(server: McpServer) {
  server.registerTool(
    "fsm_create",
    {
      description: `Create a finite state machine definition.

An FSM definition consists of:
- id: Unique identifier
- initial: Initial state name
- states: Map of state definitions with documents, entry actions, and transitions
- documentTypes: JSON Schema definitions for document validation

States have:
- documents: Array of { id, type, data } for initial document setup
- entry: Array of actions executed when entering state
- on: Map of event name to transition(s)
- type: "final" for terminal states

Transitions have:
- target: Destination state name

Action types:
- emit: Emit an event
  { type: "emit", event: "order.approved", data: {...} }

- llm: Call LLM with context
  { type: "llm", provider: "anthropic", model: "claude-sonnet-4-6", prompt: "...", tools: [...], outputTo: "result" }

- agent: Invoke Atlas agent
  { type: "agent", agentId: "weather-fetcher", outputTo: "weather" }

- notification: Surface a notification to the user
  { type: "notification", title: "...", body: "..." }

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
  "states": {
    "pending": {
      "documents": [
        { "id": "order", "type": "Order", "data": { "total": 150, "status": "pending" } }
      ],
      "on": {
        "APPROVE": {
          "target": "approved"
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
