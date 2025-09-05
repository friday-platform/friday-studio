/**
 * File Tool - Create an object with file data from a prompt
 *
 * Create an object with file data from a prompt using the Vercel `tool` function
 */

import { anthropic } from "@ai-sdk/anthropic";
import { generateObject, tool } from "ai";
import { z } from "zod/v4";

export const fileOutput = tool({
  description: "Create an object with file data from a prompt using the Vercel `tool` function",
  inputSchema: z.object({
    prompt: z.string().describe("Prompt provided to generate the file data"),
  }),
  execute: async ({ prompt }) => {
    const { object } = await generateObject({
      model: anthropic("claude-sonnet-4-20250514"),
      schema: z.object({
        data: z.object({ name: z.string(), type: z.string(), size: z.number(), path: z.string() }),
      }),
      prompt,
    });

    return object;
  },
});
