import { smallLLM } from "@atlas/llm";
import type { Logger } from "@atlas/logger";
import type { Parallel } from "parallel-web";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Types (ported from web-search/types.ts)
// ---------------------------------------------------------------------------

export type SearchResult = Parallel.Beta.SearchResult;

export const QueryAnalysisSchema = z.object({
  complexity: z
    .enum(["simple", "complex"])
    .describe(
      'Query complexity: "simple" for direct lookups (who is X, what is Y, define Z), "complex" for multi-faceted research, comparisons, analysis, or trends',
    ),
  searchQueries: z
    .array(z.string().max(200))
    .min(2)
    .max(10)
    .describe(
      "2-10 strategic keyword queries targeting different facets of the research. Include specific terms, product names, or key concepts. For many items, combine related ones into fewer queries.",
    ),
  includeDomains: z
    .array(z.string())
    .optional()
    .describe("Specific domains to include - only if user explicitly mentions sites"),
  excludeDomains: z
    .array(z.string())
    .optional()
    .describe("Specific domains to exclude - only if user explicitly mentions sites"),
  recencyDays: z
    .number()
    .int()
    .min(1)
    .max(365)
    .optional()
    .describe(
      "Filter results to this many days back. Use for news/monitoring (7), recent trends (30-90), or annual reviews (365). Omit for timeless or historical queries.",
    ),
});

export type QueryAnalysis = z.infer<typeof QueryAnalysisSchema>;

// ---------------------------------------------------------------------------
// Search execution (ported from web-search/search-tool.ts)
// ---------------------------------------------------------------------------

const PARALLEL_MAX_OBJECTIVE = 4500;

async function condenseObjective(objective: string, logger: Logger): Promise<string> {
  if (objective.length <= PARALLEL_MAX_OBJECTIVE) return objective;

  logger.info("Condensing long objective", { originalLength: objective.length });

  try {
    const condensed = await smallLLM({
      system:
        "Extract the core search question from this context. Output ONLY the search query, max 500 chars.",
      prompt: objective,
      maxOutputTokens: 250,
    });

    logger.info("Objective condensed", { newLength: condensed.length });
    return condensed;
  } catch (error) {
    logger.warn("Failed to condense objective, truncating", { error });
    return objective.slice(0, PARALLEL_MAX_OBJECTIVE);
  }
}

export function computeAfterDate(recencyDays: number): string {
  const date = new Date();
  date.setDate(date.getDate() - recencyDays);
  return date.toISOString().slice(0, 10);
}

export function filterStaleResults(
  result: SearchResult,
  cutoff: string,
  logger: Logger,
): SearchResult {
  const before = result.results.length;

  // Keep results without publish_date — the API's after_date is the primary
  // filter; this client-side pass is a defensive safety net, not a strict gate.
  const filtered = result.results.filter((r) => {
    if (!r.publish_date) return true;
    return r.publish_date >= cutoff;
  });

  if (filtered.length < before) {
    logger.info("Filtered stale results", {
      before,
      after: filtered.length,
      cutoff,
      removed: before - filtered.length,
    });
  }

  return { ...result, results: filtered };
}

export function resolveDefaultRecencyDays(
  config: Record<string, unknown> | undefined,
): number | undefined {
  const raw = config?.defaultRecencyDays;
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 1 && raw <= 365) {
    return raw;
  }
  return undefined;
}

export async function executeSearch(
  client: Parallel,
  objective: string,
  analysis: QueryAnalysis,
  logger: Logger,
): Promise<SearchResult> {
  objective = await condenseObjective(objective, logger);

  const sourcePolicy: Parallel.SourcePolicy = {};

  if (analysis.includeDomains?.length) {
    sourcePolicy.include_domains = analysis.includeDomains;
  }
  if (analysis.excludeDomains?.length) {
    sourcePolicy.exclude_domains = analysis.excludeDomains;
  }

  let afterDate: string | undefined;
  if (analysis.recencyDays) {
    afterDate = computeAfterDate(analysis.recencyDays);
    sourcePolicy.after_date = afterDate;
  }

  const finalPolicy = Object.keys(sourcePolicy).length > 0 ? sourcePolicy : undefined;

  logger.info("Executing search", { objective, analysis, sourcePolicy: finalPolicy });

  const result = await client.beta.search({
    mode: "agentic",
    objective,
    search_queries: analysis.searchQueries,
    source_policy: finalPolicy,
    max_results: analysis.complexity === "simple" ? 8 : 15,
  });

  logger.info("Search completed", {
    searchId: result.search_id,
    resultCount: result.results.length,
    usage: result.usage,
  });

  if (afterDate) {
    return filterStaleResults(result, afterDate, logger);
  }

  return result;
}
