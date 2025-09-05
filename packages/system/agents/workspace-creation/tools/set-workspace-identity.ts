import { tool } from "ai";
import { z } from "zod/v4";
import type { WorkspaceBuilder } from "../builder.ts";

export function getSetWorkspaceIdentityTool(builder: WorkspaceBuilder) {
  return tool({
    description: "Set the workspace name and description",
    inputSchema: z.object({
      name: z.string().describe("Workspace name in kebab-case"),
      description: z.string().describe("Clear description of what the workspace does"),
    }),
    execute: ({ name, description }) => {
      builder.setIdentity(name, description);
      return { success: true, name, description };
    },
  });
}
