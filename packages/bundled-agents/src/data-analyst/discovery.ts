/** LLM-based data source discovery. Extracts artifact IDs from the resource catalog in the prompt. */

import { registry, traceModel } from "@atlas/llm";
import { generateObject } from "ai";
import { z } from "zod";

const ResolvedDataSourcesSchema = z.object({
  question: z
    .string()
    .describe("The analytical question extracted from the prompt, cleaned of resource references"),
  artifactIds: z
    .array(z.string())
    .describe(
      "Artifact IDs of database-type resources to ATTACH for DuckDB analysis. " +
        "Only include IDs from the Datasets section (artifact-ref with database type). " +
        "Do NOT include file artifacts or external resources.",
    ),
});

export type ResolvedDataSources = z.infer<typeof ResolvedDataSourcesSchema>;

const DISCOVERY_SYSTEM_PROMPT = `You are a data source resolver. Your job is to:
1. Extract the analytical question from the user's prompt
2. Identify which database datasets should be loaded for analysis

The prompt may contain a "## Workspace Resources" section with available data sources.
Only include artifact IDs from the "Datasets" category — these are database-type artifacts
that can be queried via DuckDB. Do NOT include artifacts from "Files" or "External" sections.

If the prompt contains artifact UUIDs directly (e.g. in the format xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx),
include those as well if they appear in a Datasets context.

If no datasets are referenced, return an empty artifactIds array.`;

/** Resolves which database artifacts to load via a lightweight haiku model call. */
export async function discoverDataSources(
  prompt: string,
  abortSignal?: AbortSignal,
): Promise<ResolvedDataSources> {
  const { object } = await generateObject({
    model: traceModel(registry.languageModel("anthropic:claude-haiku-4-5")),
    schema: ResolvedDataSourcesSchema,
    abortSignal,
    prompt,
    system: DISCOVERY_SYSTEM_PROMPT,
  });

  return object;
}
