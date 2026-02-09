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
