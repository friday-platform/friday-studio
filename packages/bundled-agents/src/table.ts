/**
 * Table Agent - Generate structured table data with headers and rows
 *
 * Creates table artifacts from natural language prompts
 */

import { createAgent, repairJson } from "@atlas/agent-sdk";
import { client, parseResult } from "@atlas/client/v2";
import { getDefaultProviderOpts, registry } from "@atlas/llm";
import { stringifyError } from "@atlas/utils";
import { generateObject } from "ai";
import { z } from "zod";

const TableDataSchema = z.object({
  headers: z.array(z.string()).describe("Column headers for the table"),
  rows: z.array(z.record(z.string(), z.string())).describe("Table rows as key-value records"),
});

type TableAgentResult = { artifactId: string; type: string; summary: string; rowCount: number };

export const tableAgent = createAgent<string, TableAgentResult>({
  id: "table",
  displayName: "Table Generator",
  version: "1.0.0",
  description:
    "Generate structured tables with headers and rows from natural language descriptions",
  expertise: {
    domains: ["data", "tables", "visualization"],
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
        model: registry.languageModel("anthropic:claude-haiku-4-5"),
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

      // Create artifact with the table data
      const artifactResponse = await parseResult(
        client.artifactsStorage.index.$post({
          json: {
            data: {
              type: "table",
              version: 1,
              data: { headers: result.object.headers, rows: result.object.rows },
            },
            summary: `Generated table: ${prompt.slice(0, 100)}${prompt.length > 100 ? "..." : ""}`,
            workspaceId: session.workspaceId,
            chatId: session.streamId,
          },
        }),
      );

      if (!artifactResponse.ok) {
        throw new Error(
          `Failed to create table artifact: ${stringifyError(artifactResponse.error)}`,
        );
      }

      const artifactId = artifactResponse.data.artifact.id;
      const rowCount = result.object.rows.length;

      // Emit outline update
      stream?.emit({
        type: "data-outline-update",
        data: {
          id: "table-generator",
          content: artifactResponse.data.artifact.summary,
          title: "Table",
          timestamp: Date.now(),
          artifactId,
          artifactLabel: "View Table",
        },
      });

      return {
        artifactId,
        type: "table",
        summary: artifactResponse.data.artifact.summary,
        rowCount,
      };
    } catch (error) {
      logger.error("table agent failed", { error });
      throw error;
    }
  },
});
