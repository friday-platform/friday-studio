/**
 * Table Tool - Create an object with table headers and rows using a prompt
 *
 * Create an object with table headers and rows from a prompt using the Vercel `tool` function
 */

import { anthropic } from "@ai-sdk/anthropic";
import { generateObject, tool } from "ai";
import { z } from "zod";

/**
 * Workspace Creation Tool - Create a workspace from a prompt
 * IMPORTANT THINGS
 * - order of items
 * - don't show the summary details in situ because it will change during conversation
 * - add click to open and view summary at any point
 *
 * - [ ] agents/services it will create
 * - [ ] what it will do (use signal information here (for the prompt))
 */

// This is a backup for the eventual artifact pattern. One issue is that the data from this will never be deterministic
export const workspaceSummary = tool({
  description:
    "Describe the workspace with a brief description of how it will work and the agents it will use",
  inputSchema: z.object({
    prompt: z.string().describe("Prompt provided to generate the workspace summary"),
  }),
  execute: async ({ prompt }) => {
    const { object } = await generateObject({
      model: anthropic("claude-sonnet-4-20250514"),
      schema: z.object({
        data: z.object({
          description: z
            .string()
            .describe("Summary of the workspace prioritizing the signal information."),
          agents: z.array(z.string()).describe("List all agents the workspace will use."),
        }),
      }),
      prompt,
    });

    return object;
  },
});
