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
      "Artifact IDs to ATTACH for DuckDB analysis. " +
        "Include UUIDs from Signal Data payload AND from the Datasets section. " +
        "Do NOT include IDs from the Files or External sections of Workspace Resources.",
    ),
});

export type ResolvedDataSources = z.infer<typeof ResolvedDataSourcesSchema>;

const DISCOVERY_SYSTEM_PROMPT = `You are a data source resolver. Your job is to:
1. Extract the analytical question from the user's prompt
2. Identify which database datasets should be loaded for analysis

Artifact IDs come from two places — check BOTH:

1. **Signal Data** — The prompt may contain a "## Signal Data" JSON block with artifact IDs
   passed as signal payload values (e.g. "csv_file": "<uuid>"). These are the PRIMARY data
   sources and should ALWAYS be included.

2. **Workspace Resources** — The prompt may contain a "## Workspace Resources" section.
   Include artifact IDs from the "Datasets" category (database-type artifacts queryable via
   DuckDB). Do NOT include IDs from "Files" or "External" sections.

If the prompt contains artifact UUIDs (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx format) in either
Signal Data or Datasets, include them. If no artifact IDs are found anywhere, return an empty
artifactIds array.`;

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
