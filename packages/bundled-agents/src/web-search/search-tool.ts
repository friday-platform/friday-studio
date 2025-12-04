import type { Logger } from "@atlas/logger";
import type { Parallel } from "parallel-web";
import type { QueryAnalysis, SearchResult } from "./types.ts";

export async function executeSearch(
  client: Parallel,
  objective: string,
  analysis: QueryAnalysis,
  logger: Logger,
): Promise<SearchResult> {
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
