/**
 * Table Agent - Generate structured table data with headers and rows
 */

import { createAgent, err, ok, repairJson } from "@atlas/agent-sdk";
import { TableDataSchema } from "@atlas/core/artifacts";
import { getDefaultProviderOpts, registry, traceModel } from "@atlas/llm";
import { stringifyError } from "@atlas/utils";
import { generateObject } from "ai";
import { z } from "zod";

const TableOutputSchema = z.object({
  rowCount: z.number().describe("Number of rows in the generated table"),
  title: z.string().describe("Table title"),
  headers: z.array(z.string()).describe("Column headers"),
  rows: z.array(z.array(z.string())).describe("Table rows"),
});

type TableAgentResult = z.infer<typeof TableOutputSchema>;

export const tableAgent = createAgent<string, TableAgentResult>({
  id: "table",
  displayName: "Table Generator",
  version: "1.0.0",
  summary:
    "Generate structured table data from LLM knowledge for comparison charts and reference tables.",
  description:
    "Generates a static table from LLM knowledge. USE FOR: comparison charts, reference tables, structured lists for presentation.",
  constraints:
    "Generates from LLM knowledge only. Cannot query databases or read files. For tables from actual data, use data-analyst (artifacts) or no capability with resource_read (workspace tables).",
  outputSchema: TableOutputSchema,
  expertise: {
    examples: [
      "Create a table of the top 5 programming languages with columns for name, year created, and creator",
      "Generate a comparison table of cloud providers with pricing and features",
      "Make a table showing the planets in our solar system with their properties",
    ],
  },

  handler: async (prompt, { logger, stream, abortSignal }) => {
    const system = `You generate structured table data with headers and rows based on the user's request.
Output clean, well-organized data appropriate for tabular display.`;

    try {
      stream?.emit({
        type: "data-tool-progress",
        data: { toolName: "Table Generator", content: "Generating table data" },
      });

      const result = await generateObject({
        model: traceModel(registry.languageModel("anthropic:claude-haiku-4-5")),
        schema: TableDataSchema,
        experimental_repairText: repairJson,
        abortSignal,
        maxRetries: 3,
        messages: [
          { role: "system", content: system, providerOptions: getDefaultProviderOpts("anthropic") },
          { role: "user", content: prompt },
        ],
      });

      logger.debug("AI SDK generateObject completed", {
        agent: "table",
        step: "generate-table-data",
        usage: result.usage,
      });

      const { title, headers, rows } = result.object;
      return ok({ rowCount: rows.length, title, headers, rows });
    } catch (error) {
      logger.error("table agent failed", { error });
      return err(stringifyError(error));
    }
  },
});
