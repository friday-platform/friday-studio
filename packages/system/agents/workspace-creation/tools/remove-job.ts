import type { Logger } from "@atlas/logger";
import { tool } from "ai";
import { z } from "zod/v4";
import type { WorkspaceBuilder } from "../builder.ts";

export function getRemoveJobTool(builder: WorkspaceBuilder, logger: Logger) {
  return tool({
    description: "Remove a job from the workspace",
    inputSchema: z.object({ id: z.string().describe("ID of the job to remove") }),
    execute: ({ id }) => {
      logger.info("Removing job", { id });
      builder.removeJob(id);
      return { success: true, id };
    },
  });
}
