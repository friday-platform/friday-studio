/**
 * MCP tool for validating FSM definitions
 */

import { stringifyError } from "@atlas/utils";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { FSMDefinitionSchema } from "../schema.ts";
import { validateFSMStructure } from "../validator.ts";
import { createErrorResponse, createSuccessResponse } from "./utils.ts";

const ValidateFSMInputSchema = z.object({
  definition: z.unknown().describe("FSM definition to validate"),
});

/**
 * Register the fsm_validate tool
 *
 * Validates an FSM definition and returns detailed validation results.
 */
export function registerFSMValidateTool(server: McpServer) {
  server.registerTool(
    "fsm_validate",
    {
      description: `Validate a finite state machine definition.

Checks for:
- Structural integrity (initial state exists, all states reachable, valid transitions)
- Transition validity (all targets exist, guards/actions defined)
- Function definitions (all referenced guards/actions exist with code)
- Document consistency (all referenced document types declared)
- Code completeness (no empty function/tool code)

Returns detailed validation result with errors and warnings.`,
      inputSchema: ValidateFSMInputSchema.shape,
    },
    ({ definition }: { definition: unknown }) => {
      try {
        // First parse with Zod schema
        const validated = FSMDefinitionSchema.parse(definition);

        // Then validate with comprehensive validator
        const result = validateFSMStructure(validated);

        if (result.valid) {
          return createSuccessResponse({
            valid: true,
            fsm: validated,
            warnings: result.warnings,
            summary: {
              id: validated.id,
              initial: validated.initial,
              stateCount: Object.keys(validated.states).length,
              functionCount: validated.functions ? Object.keys(validated.functions).length : 0,
              toolCount: validated.tools ? Object.keys(validated.tools).length : 0,
              documentTypeCount: validated.documentTypes
                ? Object.keys(validated.documentTypes).length
                : 0,
            },
          });
        } else {
          return createErrorResponse("FSM validation failed", {
            errors: result.errors,
            warnings: result.warnings,
          });
        }
      } catch (error) {
        if (error instanceof z.ZodError) {
          return createErrorResponse("FSM validation failed", {
            errors: error.issues.map((e) => `${e.path.join(".")}: ${e.message}`),
          });
        }
        return createErrorResponse("FSM validation failed", stringifyError(error));
      }
    },
  );
}
