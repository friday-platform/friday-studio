/**
 * Table Tool - Create an object with table headers and rows using a prompt
 *
 * Create an object with table headers and rows from a prompt using the Vercel `tool` function
 */

import { repairJson } from "@atlas/agent-sdk";
import { getDefaultProviderOpts, registry } from "@atlas/llm";
import { logger } from "@atlas/logger";
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
    const result = await generateObject({
      model: registry.languageModel("anthropic:claude-haiku-4-5"),
      schema: TableSchema,
      experimental_repairText: repairJson,
      messages: [
        {
          role: "system",
          content: "You generate table data with headers and rows based on the user's request.",
          providerOptions: getDefaultProviderOpts("anthropic"),
        },
        { role: "user", content: prompt },
      ],
    });
    logger.debug("AI SDK generateObject completed", {
      agent: "conversation-table",
      step: "generate-table-data",
      usage: result.usage,
    });

    return result.object;
  },
});
