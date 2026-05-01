/**
 * MCP tool for converting FSM definitions to YAML
 */

import { stringifyError } from "@atlas/utils";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { FSMDefinitionSchema } from "../schema.ts";
import * as serializer from "../serializer.ts";
import { createErrorResponse, createSuccessResponse } from "./utils.ts";

const FSMToYAMLInputSchema = z.object({
  definition: FSMDefinitionSchema.describe("FSM definition to convert to YAML"),
});

/**
 * Register the fsm_to_yaml tool
 *
 * Converts an FSM definition to YAML format for file storage
 */
export function registerFSMToYAMLTool(server: McpServer) {
  server.registerTool(
    "fsm_to_yaml",
    {
      description: `Convert an FSM definition to YAML format.

Takes a validated FSM definition and returns YAML string suitable for saving to a file.

The output can be loaded later using loadFromYAML() or loadFromFile() from @atlas/fsm-engine.`,
      inputSchema: FSMToYAMLInputSchema.shape,
    },
    ({ definition }: { definition: unknown }) => {
      try {
        const validated = FSMDefinitionSchema.parse(definition);
        const yaml = serializer.toYAML(validated);

        return createSuccessResponse({
          yaml,
          summary: { id: validated.id, lines: yaml.split("\n").length },
        });
      } catch (error) {
        return createErrorResponse("Failed to convert FSM to YAML", stringifyError(error));
      }
    },
  );
}
