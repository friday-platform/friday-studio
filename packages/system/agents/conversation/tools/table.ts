/**
 * Table Tool - Create an object with table headers and rows using a prompt
 *
 * Create an object with table headers and rows from a prompt using the Vercel `tool` function
 */

import { anthropic } from "@atlas/core";
import { generateObject, tool } from "ai";
import { z } from "zod";

export const TableSchema = z.object({
  data: z.object({ headers: z.array(z.string()), rows: z.array(z.record(z.string(), z.string())) }),
});

export type Table = z.Infer<typeof TableSchema>;

export const tableOutput = tool({
  description:
    "Create an object with table headers and rows from a prompt using the Vercel `tool` function",
  inputSchema: z.object({
    prompt: z.string().describe("Prompt provided to generate the table headers and rows"),
  }),
  execute: async ({ prompt }) => {
    const { object } = await generateObject({
      model: anthropic("claude-haiku-4-5"),
      schema: TableSchema,
      prompt,
    });

    return object;
  },
});
