/**
 * Table Agent - Generate structured table data with headers and rows
 *
 * Creates table artifacts from natural language prompts
 */

import {
  type ArtifactRef,
  createAgent,
  err,
  type OutlineRef,
  ok,
  repairJson,
} from "@atlas/agent-sdk";
import { client, parseResult } from "@atlas/client/v2";
import { TableDataSchema } from "@atlas/core/artifacts";
import { getDefaultProviderOpts, registry, traceModel } from "@atlas/llm";
import { stringifyError, truncateUnicode } from "@atlas/utils";
import { generateObject } from "ai";
import { z } from "zod";

const TableOutputSchema = z.object({
  rowCount: z.number().describe("Number of rows in the generated table"),
});

type TableAgentResult = z.infer<typeof TableOutputSchema>;

export const tableAgent = createAgent<string, TableAgentResult>({
  id: "table",
  displayName: "Table Generator",
  version: "1.0.0",
  description:
    "Generates a static table artifact from LLM knowledge. USE FOR: comparison charts, reference tables, structured lists for presentation.",
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

  handler: async (prompt, { session, logger, stream, abortSignal }) => {
    const system = `You generate structured table data with headers and rows based on the user's request.
Output clean, well-organized data appropriate for tabular display.`;

    try {
      // Progress: starting execution
      stream?.emit({
        type: "data-tool-progress",
        data: { toolName: "Table Generator", content: "Generating table data" },
      });

      const result = await generateObject({
        model: traceModel(registry.languageModel("anthropic:claude-haiku-4-5")),
        schema: TableDataSchema,
        experimental_repairText: repairJson,
        abortSignal,
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

      const tableData = result.object;

      // Create artifact with the table data
      const artifactResponse = await parseResult(
        client.artifactsStorage.index.$post({
          json: {
            data: { type: "table", version: 1, data: tableData },
            title: tableData.title || "Generated Table",
            summary: `Generated table: ${truncateUnicode(prompt, 100, "...")}`,
            workspaceId: session.workspaceId,
            chatId: session.streamId,
          },
        }),
      );

      if (!artifactResponse.ok) {
        return err(`Failed to create table artifact: ${stringifyError(artifactResponse.error)}`);
      }

      const { id: artifactId, type, summary: artifactSummary } = artifactResponse.data.artifact;
      const rowCount = tableData.rows.length;

      const artifactRefs: ArtifactRef[] = [{ id: artifactId, type, summary: artifactSummary }];

      const outlineRefs: OutlineRef[] = [
        {
          service: "internal",
          title: "Table",
          content: artifactResponse.data.artifact.summary,
          artifactId,
          artifactLabel: "View Table",
          type: "table",
        },
      ];

      return ok({ rowCount }, { artifactRefs, outlineRefs });
    } catch (error) {
      logger.error("table agent failed", { error });
      return err(stringifyError(error));
    }
  },
});
