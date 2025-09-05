import type { Logger } from "@atlas/logger";
import { tool } from "ai";
import { z } from "zod/v4";
import type { WorkspaceBuilder } from "../builder.ts";

export function getExportWorkspaceTool(builder: WorkspaceBuilder, logger: Logger) {
  return tool({
    description: "Export the complete workspace configuration",
    inputSchema: z.object({}),
    execute: () => {
      logger.debug("Exporting workspace...");
      const config = builder.exportConfig();
      const summary = builder.getSummary();

      return { config, summary };
    },
  });
}

export function getGetSummaryTool(builder: WorkspaceBuilder) {
  return tool({
    description: "Get current workspace building progress",
    inputSchema: z.object({}),
    execute: () => {
      const summary = builder.getSummary();
      return summary;
    },
  });
}
