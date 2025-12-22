import { smallLLM } from "@atlas/llm";
import type { Logger } from "@atlas/logger";
import type { Parallel } from "parallel-web";
import type { QueryAnalysis, SearchResult } from "./types.ts";

const PARALLEL_MAX_OBJECTIVE = 4500;

async function condenseObjective(objective: string, logger: Logger): Promise<string> {
  if (objective.length <= PARALLEL_MAX_OBJECTIVE) return objective;

  logger.info("Condensing long objective", { originalLength: objective.length });

  const condensed = await smallLLM({
    system:
      "Extract the core search question from this context. Output ONLY the search query, max 500 chars.",
    prompt: objective,
    maxOutputTokens: 200,
  });

  logger.info("Objective condensed", { newLength: condensed.length });
  return condensed;
}

export async function executeSearch(
  client: Parallel,
  objective: string,
  analysis: QueryAnalysis,
  logger: Logger,
): Promise<SearchResult> {
  objective = await condenseObjective(objective, logger);

  const sourcePolicy =
    analysis.includeDomains?.length || analysis.excludeDomains?.length
      ? { include_domains: analysis.includeDomains, exclude_domains: analysis.excludeDomains }
      : undefined;

  logger.info("Executing search", { objective, analysis, sourcePolicy });

  const result = await client.beta.search({
    mode: "agentic",
    objective,
    search_queries: analysis.searchQueries,
    source_policy: sourcePolicy,
    max_results: analysis.complexity === "simple" ? 8 : 15,
  });

  logger.info("Search completed", {
    searchId: result.search_id,
    resultCount: result.results.length,
    usage: result.usage,
  });

  return result;
}
