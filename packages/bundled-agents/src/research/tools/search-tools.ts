/**
 * Create Tavily search and extract tools that auto-store results.
 */

import { anthropic } from "@ai-sdk/anthropic";
import type { Logger } from "@atlas/logger";
import { getTodaysDate } from "@atlas/utils";
import type { TavilyClient, TavilyExtractResponse, TavilySearchResponse } from "@tavily/core";
import { generateObject, tool } from "ai";
import { z } from "zod/v4";
import { memoryStore } from "../memory-store.ts";

const SummarizedResultSchema = z.object({
  summary: z.string().describe("Summary (200-400 words)"),
  key_excerpts: z.string().array().describe("Key quotes/data points - max 5"),
});

type SummarizedResult = z.infer<typeof SummarizedResultSchema>;

/** Format search response as string */
function stringifySearchResult(res: TavilySearchResponse): string {
  const contentParts: string[] = [];
  for (const result of res.results) {
    contentParts.push(`\n--- Result ---`);
    contentParts.push(`Title: ${result.title}`);
    contentParts.push(`URL: ${result.url}`);
    contentParts.push(`Published: ${result.publishedDate}`);
    contentParts.push(`Content: ${result.content}`);
  }
  return contentParts.join("\n");
}

function stringifyExtractionResponse(res: TavilyExtractResponse): string {
  const contentParts: string[] = [];
  for (const result of res.results) {
    contentParts.push(`\n--- Result ---`);
    contentParts.push(`URL: ${result.url}`);
    contentParts.push(`Content: ${result.rawContent}`);
  }
  return contentParts.join("\n");
}

/** Summarize results using Haiku */
async function summarizeResults(
  resultString: string,
  query: string,
  logger: Logger,
  abortSignal?: AbortSignal,
): Promise<SummarizedResult> {
  const summarizationPrompt = `Summarize search results preserving key information.

Today's date: ${getTodaysDate()}

Content:
${resultString}

Query: "${query}"

Guidelines:
- Main findings relevant to query
- Key facts, stats, data points
- Important quotes from sources
- Dates, names, locations if relevant

Content types:
- News: who, what, when, where, why, how
- Scientific: methodology, results, conclusions
- Opinion: main arguments and support
- Product/company: features, specs, metrics

Create 200-400 word summary and up to 5 key excerpts.`;

  try {
    const { object } = await generateObject({
      model: anthropic("claude-3-5-haiku-latest"),
      prompt: summarizationPrompt,
      schema: SummarizedResultSchema,
      temperature: 0.3,
      maxOutputTokens: 1000,
      abortSignal,
    });

    logger.debug("Search results summarized", {
      query,
      summaryLength: object.summary.length,
      excerptsCount: object.key_excerpts.length,
    });

    return object;
  } catch (error) {
    logger.error("Failed to summarize search results", { error, query });
    throw new Error("Failed to summarize search results");
  }
}

type Params = { tavily: TavilyClient; logger: Logger; abortSignal?: AbortSignal };

/** Create search and extract tools with auto-storage */
export function createSubAgentTools({ tavily, logger, abortSignal }: Params) {
  const tavily_search = tool({
    description: "Web search with auto-summarization",
    inputSchema: z.object({
      query: z.string().describe("Search query"),
      search_depth: z.enum(["basic", "advanced"]).optional(),
      max_results: z.number().min(3).max(10).optional(),
      include_domains: z.array(z.string()).optional(),
      exclude_domains: z.array(z.string()).optional(),
    }),
    execute: async (input) => {
      logger.debug("Search initiated", { query: input.query });
      const response = await tavily.search(input.query, {
        searchDepth: input.search_depth || "basic",
        maxResults: input.max_results || 3,
        includeDomains: input.include_domains,
        excludeDomains: input.exclude_domains,
        includeAnswer: true,
        includeRawContent: false,
      });

      const sourceCount = response.results.length;
      const stringifiedSearch = stringifySearchResult(response);

      const summarized = await summarizeResults(
        stringifiedSearch,
        input.query,
        logger,
        abortSignal,
      );

      const rawKey = memoryStore.generateId("raw_search");
      memoryStore.storeRaw(rawKey, {
        query: input.query,
        results: response,
        timestamp: new Date().toISOString(),
      });

      memoryStore.addSummary({
        summary: summarized.summary,
        query: input.query,
        sourceCount,
        rawDataKey: rawKey,
      });

      logger.debug("Search completed", {
        query: input.query,
        summaryLength: summarized.summary.length,
        sourceCount,
      });

      return {
        summary: summarized.summary,
        key_excerpts: summarized.key_excerpts,
        sourceCount,
        hasAnswer: !!response.answer,
      };
    },
  });

  const tavily_extract = tool({
    description: "Extract URL content with auto-summarization",
    inputSchema: z.object({ urls: z.string().array().describe("URL(s) to extract content from") }),
    execute: async ({ urls }) => {
      logger.debug("Extract initiated", { urlCount: urls.length });
      const response = await tavily.extract(urls);
      const stringifiedExtraction = stringifyExtractionResponse(response);

      const query = `Extract key information from ${urls.length} URL(s)`;
      const summarized = await summarizeResults(stringifiedExtraction, query, logger, abortSignal);

      const rawKey = memoryStore.generateId("raw_extract");
      memoryStore.storeRaw(rawKey, {
        urls,
        results: response,
        timestamp: new Date().toISOString(),
      });

      memoryStore.addSummary({
        summary: summarized.summary,
        query,
        sourceCount: urls.length,
        rawDataKey: rawKey,
      });

      logger.debug("Extract completed", {
        urlCount: urls.length,
        summaryLength: summarized.summary.length,
      });

      return {
        summary: summarized.summary,
        key_excerpts: summarized.key_excerpts,
        urlCount: urls.length,
      };
    },
  });

  return { tavily_search, tavily_extract };
}
