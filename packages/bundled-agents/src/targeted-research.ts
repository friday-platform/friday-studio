import { env } from "node:process";
import { anthropic } from "@ai-sdk/anthropic";
import { createAgent, type StreamEmitter } from "@atlas/agent-sdk";
import type { Logger } from "@atlas/logger";
import { type TavilyClient, type TavilySearchOptions, tavily } from "@tavily/core";
import { generateObject, generateText } from "ai";
import { z } from "zod/v4";

// Types
interface QuerySpec {
  query: string; // Must be <400 chars for Tavily
  include_domains?: string[];
  exclude_domains?: string[];
  time_range?: "day" | "week" | "month" | "year";
}

interface ParsedQueries {
  queries: QuerySpec[];
  outputFormat: "summary" | "list" | "comparison";
}

interface SearchResult {
  title: string;
  url: string;
  content: string;
  score: number;
  originQuery: QuerySpec;
}

interface ExtractedContent {
  url: string;
  title: string;
  content: string;
  metadata: { wordCount: number; summarized?: boolean; originalTokens?: number };
}

interface FailedExtraction {
  url: string;
  error: string;
}

interface ExtractionResult {
  successful: ExtractedContent[];
  failed: FailedExtraction[];
  skipped: string[];
}

interface SourceContent {
  content: string;
  type: "extracted" | "snippet";
  title: string;
}

export interface ResearchOutput {
  prompt: string;
  parsedQueries: ParsedQueries;
  synthesis: string;
  sources: {
    searchResults: number;
    extractedCount: number;
    failedExtractions: number;
    relevantResults: number;
  };
  timing: { total: number; parse: number; search: number; extract: number; synth: number };
}

// Helper Functions

/**
 * Generates human-readable progress messages using LLM
 * Falls back to generic message on error
 */
async function generateProgressMessage(
  phase: "parsing" | "searching" | "evaluating" | "extracting" | "synthesizing",
  context: unknown,
  fallback: string,
  logger?: Logger,
  abortSignal?: AbortSignal,
): Promise<string> {
  try {
    // Convert context to a simple string representation
    const contextStr = typeof context === "string" ? context : JSON.stringify(context, null, 2);

    const phasePrompts = {
      parsing: `Extract the query topic and what requirements are being analyzed.
Examples:
- "Figuring out gravel bike requirements"
- "Parsing accommodation needs for 8 guests"
- "Understanding React vs Vue comparison request"`,

      searching: `Extract the domains being searched, query refinements, or attempt info.
Examples:
- "Searching bikeradar.com for 2024 gravel bikes"
- "Querying reddit.com/r/gravelcycling for tire clearance"
- "Refining search: adding 'carbon frame' qualifier"
- "Searching airbnb.com for tokyo listings"`,

      evaluating: `Extract the number of results and what's being filtered or checked.
Examples:
- "Checking 20 bikeradar.com results for relevance"
- "Filtering out road bike results"
- "Evaluating 15 airbnb listings"
- "Selecting 8 relevant forum posts"`,

      extracting: `Extract specific page titles, domains, or batch info.
Examples:
- "Reading bikeradar's specialized diverge review"
- "Extracting cyclingnews.com's gear guide (batch 2/3)"
- "Pulling content from 5 reddit threads"
- "Reading zillow property details"`,

      synthesizing: `Extract the output format and source count.
Examples:
- "Building comparison from 12 sources"
- "Formatting gravel bike list"
- "Creating summary from 8 articles"
- "Generating property comparison table"`,
    };

    const { text } = await generateText({
      model: anthropic("claude-3-5-haiku-latest"),
      abortSignal,
      system: `Generate a specific, informative progress update for a web research task.

<constraints>
- Maximum 6 words
- Start with capital letter (sentence case)
- Be specific about WHAT is being processed
- Include counts, domains, or specific content when available
- No generic phrases like "browsing sites" or "looking through"
</constraints>

<phase_guidance>
${phasePrompts[phase]}
</phase_guidance>`,
      prompt: `<phase>${phase}</phase>

<context>
${contextStr}
</context>

<task>
Generate a specific progress update. Focus on the actual content/domains/counts from the context.
Return ONLY the sentence-cased update text, no explanations.
</task>`,
      temperature: 0.5,
      maxOutputTokens: 50,
    });

    return text.trim();
  } catch (error) {
    logger?.warn(`Failed to generate progress message`, {
      error: error instanceof Error ? error.message : String(error),
      phase,
    });
    return fallback;
  }
}

/**
 * Parses natural language queries into structured search parameters
 * Supports reddit filtering, time ranges, and domain specifications
 */
async function parseQuery(
  query: string,
  logger?: Logger,
  abortSignal?: AbortSignal,
): Promise<ParsedQueries> {
  const schema = z.object({
    queries: z
      .array(
        z.object({
          query: z.string().describe("Search query text, must be under 400 characters"),
          include_domains: z.array(z.string()).optional().describe("Domains to search within"),
          exclude_domains: z.array(z.string()).optional().describe("Domains to exclude"),
          time_range: z.enum(["day", "week", "month", "year"]).optional().describe("Time range"),
        }),
      )
      .describe("Array of query specifications with associated filters"),
    outputFormat: z.enum(["summary", "list", "comparison"]).describe("How to format the output"),
  });

  const { object } = await generateObject({
    model: anthropic("claude-3-5-haiku-latest"),
    schema,
    abortSignal,
    system: `Parse natural language into structured search parameters for web research.

<constraints>
- Each query MUST be under 400 characters (Tavily API limit)
- Generate 1-3 queries maximum
- Focus on searchable terms, avoid natural language filler
</constraints>

<output_format_rules>
- "list": User wants discrete items
  Indicators: "find", "show", "list", "what [plural]", "which [plural]", "give me", "looking for"
  Examples: "Find me Airbnbs", "Show me restaurants", "What posts discuss X"
- "comparison": User wants to compare
  Indicators: "compare", "vs", "versus", "difference between", "which is better"
- "summary": User wants explanation (default for ambiguous queries)
  Indicators: "what is", "how does", "explain", "tell me about", "describe"
</output_format_rules>

<domain_filtering>
- "Airbnb" → include_domains: ["airbnb.com"]
- "Reddit" or "r/" → include_domains: ["reddit.com"]
- "Zillow" → include_domains: ["zillow.com"]
- "VRBO" → include_domains: ["vrbo.com"]
- Specific subreddit → include_domains: ["reddit.com/r/SUBREDDIT"]
</domain_filtering>

<query_construction>
- Include specific requirements: "8 guests", "4 bedrooms", price ranges, dates
- Avoid generic terms like "large group", "good", "best"
- For accommodations: location + capacity + specific features
</query_construction>`,
    prompt: query,
    temperature: 0.2,
    maxOutputTokens: 1000,
  });

  for (const q of object.queries) {
    if (q.query.length >= 400) {
      logger?.error(`Query exceeds limit`, {
        query: q.query.slice(0, 100),
        length: q.query.length,
      });
      throw new Error(`Query exceeds 400 character limit: "${q.query.slice(0, 100)}..."`);
    }
  }

  logger?.debug(`Parsed queries`, {
    queries: JSON.stringify(object.queries, null, 2),
    format: object.outputFormat,
  });

  return object;
}

/**
 * Executes a single search query with Tavily API
 * Enforces 400 character limit and applies domain/time filters
 */
async function searchSingle(
  querySpec: QuerySpec,
  tavilyClient: TavilyClient,
  logger?: Logger,
): Promise<SearchResult[]> {
  if (querySpec.query.length >= 400) {
    logger?.error(`Query too long for Tavily`, { length: querySpec.query.length });
    throw new Error(`Query exceeds Tavily 400 char limit: ${querySpec.query.length} chars`);
  }

  logger?.debug(`Executing search`, { query: querySpec.query, domains: querySpec.include_domains });
  const searchOptions: TavilySearchOptions = { searchDepth: "advanced", maxResults: 20 };

  if (querySpec.include_domains?.length) {
    searchOptions.includeDomains = querySpec.include_domains;
  }

  if (querySpec.exclude_domains?.length) {
    searchOptions.excludeDomains = querySpec.exclude_domains;
  }

  if (querySpec.time_range) {
    const dayMapping = { day: 1, week: 7, month: 30, year: 365 };
    searchOptions.days = dayMapping[querySpec.time_range];
  }

  const response = await tavilyClient.search(querySpec.query, searchOptions);

  const results = response.results || [];
  logger?.info(`Search completed`, { query: querySpec.query, resultCount: results.length });

  return results.map((r: { title: string; url: string; content: string; score?: number }) => ({
    title: r.title,
    url: r.url,
    content: r.content,
    score: r.score || 0.5,
    originQuery: querySpec,
  }));
}

/**
 * Uses LLM to evaluate search result relevance and suggest query improvements
 * Evaluates each result individually for better reliability
 */
async function evaluateResults(
  results: SearchResult[],
  logger?: Logger,
  abortSignal?: AbortSignal,
): Promise<{ relevant: SearchResult[]; queryModification?: string }> {
  if (results.length === 0) {
    logger?.debug(`No results to evaluate`);
    return { relevant: [], queryModification: undefined };
  }

  // Evaluate each result individually for better reliability
  const evaluations: Array<{ url: string; relevant: boolean; confidence: number }> = [];

  // Process in batches to avoid overwhelming the API
  const BATCH_SIZE = 5;
  for (let i = 0; i < results.length; i += BATCH_SIZE) {
    const batch = results.slice(i, Math.min(i + BATCH_SIZE, results.length));
    const batchPromises = batch.map(async (result) => {
      const singleResultSchema = z.object({
        relevant: z.boolean().describe("Is this result relevant to the query?"),
        confidence: z.number().describe("Confidence score between 0 and 1"),
      });

      try {
        const { object } = await generateObject({
          model: anthropic("claude-3-5-haiku-latest"),
          schema: singleResultSchema,
          abortSignal,
          system: `Evaluate if this search result directly answers the user's query.

<relevance_criteria>
1. Content directly addresses the query topic
2. Information is current and actionable
3. Source appears credible (not spam/low-quality)
4. Contains specific details, not just general information
</relevance_criteria>

<evaluation_standards>
- Relevant: Clear connection to query, useful information
- Not relevant: Off-topic, outdated, spam, or purely promotional
- When uncertain, lean toward "not relevant"
</evaluation_standards>

<confidence_scale>
- 0.9-1.0: Perfect match, highly useful
- 0.7-0.8: Good match, useful information
- 0.5-0.6: Partial match, some useful content
- 0.0-0.4: Poor match, minimal value
</confidence_scale>`,
          prompt: `<query>"${result.originQuery.query}"</query>

<result>
Title: ${result.title}
URL: ${result.url}
Provider Score: ${result.score.toFixed(2)}
Content: ${result.content.slice(0, 400)}...
</result>

<instructions>
1. Does this result directly answer the query?
2. Rate confidence 0.0-1.0 using the scale above
3. Consider content quality and source credibility
</instructions>`,
          temperature: 0.1,
          maxOutputTokens: 1000,
        });

        return { url: result.url, relevant: object.relevant, confidence: object.confidence };
      } catch (error) {
        logger?.warn(`Failed to evaluate result`, {
          url: result.url,
          error: error instanceof Error ? error.message : String(error),
        });
        // Default to not relevant if evaluation fails
        return { url: result.url, relevant: false, confidence: 0 };
      }
    });

    const batchResults = await Promise.all(batchPromises);
    evaluations.push(...batchResults);
  }

  const relevantCount = evaluations.filter((e) => e.relevant).length;
  logger?.info(`Evaluation complete`, {
    total: evaluations.length,
    relevant: relevantCount,
    ratio: (relevantCount / evaluations.length).toFixed(2),
  });

  // Check if we should suggest a query modification
  let queryModification: string | undefined;

  if (relevantCount < 3 && results.length > 0) {
    try {
      const { object } = await generateObject({
        model: anthropic("claude-3-5-haiku-latest"),
        abortSignal,
        schema: z.object({
          suggestion: z
            .string()
            .max(400)
            .optional()
            .describe(
              "Just the improved search query text, no explanation. Return undefined if current query is good",
            ),
        }),
        system: `Improve search queries that produce insufficient relevant results.

<instructions>
1. Return ONLY the improved query text, no explanations
2. Keep under 400 characters
3. Avoid "OR" statements or complex syntax
4. Focus on more specific or broader terms as needed
</instructions>

<improvement_strategies>
- Too few results: Use broader, more general terms
- Too many irrelevant results: Add specific qualifying terms
- Wrong domain focus: Adjust terminology for target domain
</improvement_strategies>`,
        prompt: `<analysis>
Original query: "${results[0]?.originQuery.query}"
Results found: ${results.length} total, ${relevantCount} relevant
Success rate: ${((relevantCount / results.length) * 100).toFixed(1)}%
</analysis>

<task>
Generate improved search query (or return "suggestion" as undefined if current query is adequate):
</task>`,
        temperature: 0.5,
        maxOutputTokens: 1000,
      });

      queryModification = object.suggestion;
      if (queryModification) {
        logger?.info(`Query modification suggested`, { newQuery: queryModification });
      }
    } catch (error) {
      logger?.warn(`Failed to suggest modification`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Build final result
  const urlToEval = new Map(evaluations.map((e) => [e.url, e]));
  const relevant = results
    .filter((r) => {
      const evaluation = urlToEval.get(r.url);
      return evaluation?.relevant ?? false;
    })
    .map((r) => {
      const evaluation = urlToEval.get(r.url);
      if (!evaluation) {
        return r;
      }
      // Blend provider score with LLM confidence
      return { ...r, score: r.score * 0.2 + evaluation.confidence * 0.8 };
    })
    .sort((a, b) => b.score - a.score);

  return { relevant, queryModification };
}

/**
 * Executes parallel searches with retry logic and query refinement
 * Emits progress via Atlas stream for real-time UI updates
 */
async function searchWithRetries(
  parsedQueries: ParsedQueries,
  tavilyClient: TavilyClient,
  options: { maxAttempts: number },
  stream?: StreamEmitter,
  logger?: Logger,
  abortSignal?: AbortSignal,
): Promise<SearchResult[]> {
  const allResults: SearchResult[] = [];
  const seenUrls = new Set<string>();
  let currentQueries = parsedQueries.queries;

  for (let attempt = 0; attempt < options.maxAttempts; attempt++) {
    const domains = currentQueries[0]?.include_domains || [];
    const progressMessage = await generateProgressMessage(
      "searching",
      {
        query: currentQueries[0]?.query,
        domains: domains.length > 0 ? domains : undefined,
        attempt: `${attempt + 1} of ${options.maxAttempts}`,
        refinedQuery: attempt > 0 && currentQueries !== parsedQueries.queries,
      },
      `Searching web (attempt ${attempt + 1} of ${options.maxAttempts})...`,
      logger,
      abortSignal,
    );

    stream?.emit({
      type: "data-tool-progress",
      data: { toolName: "Research Agent", content: progressMessage },
    });

    const batchResults = await Promise.allSettled(
      currentQueries.map((querySpec) => searchSingle(querySpec, tavilyClient, logger)),
    );

    const newResults: SearchResult[] = [];
    batchResults.forEach((result, index) => {
      if (result.status === "fulfilled") {
        const searchResults = result.value;
        searchResults.forEach((r) => {
          if (!seenUrls.has(r.url)) {
            newResults.push(r);
          }
        });
        logger?.debug(`Search batch succeeded`, {
          query: currentQueries[index]?.query,
          results: searchResults.length,
        });
      } else {
        const failedQuery = currentQueries[index];
        if (failedQuery) {
          logger?.error(`Search failed`, {
            query: failedQuery.query,
            reason: result.reason instanceof Error ? result.reason.message : String(result.reason),
          });
          // Log search failures but don't emit them as progress
        }
      }
    });

    if (newResults.length === 0 && attempt < options.maxAttempts - 1) {
      const firstQuery = currentQueries[0];
      if (firstQuery) {
        logger?.debug(`No new results, attempting query refinement`);
        const suggestion = await suggestBetterQuery(firstQuery, allResults, logger, abortSignal);
        if (suggestion) {
          logger?.info(`Retrying with modified query`, { query: suggestion.query });
          currentQueries = [suggestion];
          continue;
        }
      }
    }

    // Emit evaluation progress before evaluating
    if (newResults.length > 0) {
      const evalMessage = await generateProgressMessage(
        "evaluating",
        { resultCount: newResults.length, urls: newResults.slice(0, 3).map((r) => r.url) },
        "Evaluating result relevance...",
        logger,
        abortSignal,
      );
      stream?.emit({
        type: "data-tool-progress",
        data: { toolName: "Research Agent", content: evalMessage },
      });
    }

    const evaluated = await evaluateResults(newResults, logger, abortSignal);

    for (const result of evaluated.relevant) {
      if (!seenUrls.has(result.url)) {
        allResults.push(result);
        seenUrls.add(result.url);
      }
    }

    if (evaluated.queryModification && attempt < options.maxAttempts - 1) {
      const modifiedQuery: QuerySpec = {
        query: evaluated.queryModification,
        include_domains: currentQueries[0]?.include_domains,
        time_range: currentQueries[0]?.time_range,
      };
      currentQueries = [modifiedQuery];
    }
  }

  // Emit final evaluation summary
  if (allResults.length > 0) {
    const summaryMessage = await generateProgressMessage(
      "evaluating",
      { relevantResults: allResults.length },
      `Selected ${allResults.length} relevant results`,
      logger,
      abortSignal,
    );
    stream?.emit({
      type: "data-tool-progress",
      data: { toolName: "Research Agent", content: summaryMessage },
    });
  }

  return allResults;
}

/**
 * Suggests improved search queries based on current results
 * Called when results are insufficient or irrelevant
 */
async function suggestBetterQuery(
  originalQuery: QuerySpec,
  currentResults: SearchResult[],
  logger?: Logger,
  abortSignal?: AbortSignal,
): Promise<QuerySpec | undefined> {
  const schema = z.object({
    query: z.string().max(400).describe("Just the new search query text, no explanations or prose"),
    shouldModify: z.boolean(),
  });

  const formatter = new Intl.DateTimeFormat("en-US", { dateStyle: "full" });

  try {
    const { object } = await generateObject({
      model: anthropic("claude-3-5-haiku-latest"),
      schema,
      abortSignal,
      system: `Improve search queries based on result quality. Current date: ${formatter.format(new Date())}

<instructions>
1. Return ONLY the new query text, no explanations or analysis
2. Keep under 400 characters
3. Preserve domain context from original query
4. Use simple, searchable terms
5. If there are domains, make sure to include them in the new query and do not suggest new domains.
</instructions>

<strategy>
${
  currentResults.length === 0
    ? "No results found: Use broader, more general terms"
    : "Weak results: Use more specific, targeted terms"
}
</strategy>`,
      prompt: `<original_query>
Query: "${originalQuery.query}"
${originalQuery.include_domains ? `Target domains: ${originalQuery.include_domains.join(", ")}` : ""}
Results found: ${currentResults.length}
</original_query>

<task>Provide improved query text:</task>`,
      temperature: 0.5,
      maxOutputTokens: 1000,
    });

    if (!object.shouldModify) {
      logger?.debug(`No query modification needed`);
      return undefined;
    }

    logger?.info(`Query improved`, { original: originalQuery.query, improved: object.query });

    return {
      query: object.query,
      include_domains: originalQuery.include_domains,
      exclude_domains: originalQuery.exclude_domains,
      time_range: originalQuery.time_range,
    };
  } catch (error) {
    logger?.warn(`Failed to suggest better query`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/**
 * Extracts full content from top search results
 * Handles extraction failures gracefully, falls back to snippets
 */
async function extractTopResults(
  results: SearchResult[],
  query: string,
  tavilyClient: TavilyClient,
  stream?: StreamEmitter,
  logger?: Logger,
  abortSignal?: AbortSignal,
): Promise<ExtractionResult> {
  const MAX_EXTRACTIONS = 15;
  const urls = results.slice(0, MAX_EXTRACTIONS).map((r) => r.url);
  const skipped = results.slice(MAX_EXTRACTIONS).map((r) => r.url);

  logger?.debug(`Starting extraction`, { urls: urls.length, skipped: skipped.length });
  // Initial extraction message removed - batch progress will be shown instead

  const successful: ExtractedContent[] = [];
  const failed: FailedExtraction[] = [];

  const BATCH_SIZE = 5;
  const totalBatches = Math.ceil(urls.length / BATCH_SIZE);

  for (let i = 0; i < urls.length; i += BATCH_SIZE) {
    const batch = urls.slice(i, Math.min(i + BATCH_SIZE, urls.length));
    const currentBatch = Math.floor(i / BATCH_SIZE) + 1;

    const extractMessage = await generateProgressMessage(
      "extracting",
      {
        urls: batch,
        titles: results.slice(i, Math.min(i + BATCH_SIZE, urls.length)).map((r) => r.title),
        batch: totalBatches > 1 ? `${currentBatch} of ${totalBatches}` : undefined,
        totalPages: urls.length,
      },
      totalBatches > 1
        ? `Extracting content from ${urls.length} pages (batch ${currentBatch}/${totalBatches})...`
        : `Extracting content from ${urls.length} pages...`,
      logger,
      abortSignal,
    );

    stream?.emit({
      type: "data-tool-progress",
      data: { toolName: "Research Agent", content: extractMessage },
    });

    try {
      const response = await tavilyClient.extract(batch);

      if (response.results && Array.isArray(response.results)) {
        for (const result of response.results) {
          const content = result.rawContent || "";
          const processed = await summarizeIfLarge(content, query, logger, abortSignal);

          successful.push({
            url: result.url,
            title: result.url,
            content: processed.content,
            metadata: {
              wordCount: processed.content.split(/\s+/).length,
              summarized: processed.wasSummarized,
              originalTokens: processed.originalTokens,
            },
          });
        }
      }

      if (response.failedResults && Array.isArray(response.failedResults)) {
        for (const failure of response.failedResults) {
          logger?.warn(`Extraction failed`, { url: failure.url, error: failure.error });
          failed.push({ url: failure.url, error: failure.error || "Extraction failed" });
        }
      }
    } catch (error) {
      logger?.error(`Batch extraction failed`, {
        batchSize: batch.length,
        error: error instanceof Error ? error.message : String(error),
      });
      for (const url of batch) {
        failed.push({ url, error: error instanceof Error ? error.message : "Extraction failed" });
      }
    }
  }

  logger?.info(`Extraction complete`, {
    successful: successful.length,
    failed: failed.length,
    skipped: skipped.length,
  });

  return { successful, failed, skipped };
}

/**
 * Summarizes large content to fit within token limits
 * Preserves key information relevant to the original query
 */
async function summarizeIfLarge(
  content: string,
  query: string,
  logger?: Logger,
  abortSignal?: AbortSignal,
): Promise<{ content: string; wasSummarized: boolean; originalTokens?: number }> {
  const maxTokens = 2000;
  const estimatedTokens = Math.ceil(content.length / 4);

  if (estimatedTokens <= maxTokens) {
    return { content, wasSummarized: false };
  }

  logger?.debug(`Summarizing large content`, { originalTokens: estimatedTokens, maxTokens });

  const { text } = await generateText({
    model: anthropic("claude-3-5-haiku-latest"),
    abortSignal,
    system: `Extract information relevant to the user's query from large content.

<extraction_criteria>
1. Include direct answers to the query
2. Preserve specific details: numbers, dates, prices, names
3. Keep relevant quotes and exact phrases
4. Include supporting context for claims
5. Maintain factual accuracy
</extraction_criteria>

<instructions>
- Focus on query-relevant content only
- Preserve original wording for key facts
- Remove generic filler and irrelevant sections
- Keep logical flow between extracted sections
</instructions>`,
    prompt: `<query>"${query}"</query>

<content>
${content}
</content>

<task>Extract only the sections relevant to answering the query:</task>`,
    temperature: 0.3,
    maxOutputTokens: maxTokens,
  });

  logger?.debug(`Content summarized`, { originalTokens: estimatedTokens, newLength: text.length });

  return { content: text, wasSummarized: true, originalTokens: estimatedTokens };
}

/**
 * Synthesizes search and extraction results into formatted output
 * Includes proper citations and follows requested output format
 */
async function synthesizeResults(input: {
  query: string;
  parsedQueries: ParsedQueries;
  searchResults: SearchResult[];
  extracted: ExtractionResult;
  abortSignal?: AbortSignal;
}): Promise<string> {
  const sources = new Map<string, SourceContent>();

  for (const item of input.extracted.successful) {
    sources.set(item.url, { content: item.content, type: "extracted", title: item.title });
  }

  for (const failed of input.extracted.failed) {
    const snippet = input.searchResults.find((r) => r.url === failed.url);
    if (snippet) {
      sources.set(failed.url, { content: snippet.content, type: "snippet", title: snippet.title });
    }
  }

  for (const skippedUrl of input.extracted.skipped) {
    const snippet = input.searchResults.find((r) => r.url === skippedUrl);
    if (snippet && !sources.has(skippedUrl)) {
      sources.set(skippedUrl, { content: snippet.content, type: "snippet", title: snippet.title });
    }
  }

  const sourceText = Array.from(sources.entries())
    .map(([url, source]) => {
      const typeLabel = source.type.toUpperCase();
      return `[${typeLabel}] ${source.title}
              URL: ${url}
              ${source.content}`;
    })
    .join("\n\n---\n\n");

  const { text } = await generateText({
    model: anthropic("claude-sonnet-4-20250514"),
    abortSignal: input.abortSignal,
    system: buildSynthesisPrompt(input.parsedQueries.outputFormat),
    prompt: `<query>${input.query}</query>

<sources>
${sourceText}
</sources>

<instructions>
1. Synthesize information from sources to answer the query
2. Use [text](url) format for all citations
3. Prioritize EXTRACTED sources over SNIPPET sources
4. Include specific details: prices, dates, numbers, requirements
5. If sources conflict, note the discrepancy
6. Never fabricate information not found in sources
</instructions>`,
    temperature: 0.3,
    maxOutputTokens: 4000,
  });

  return text;
}

/**
 * Builds system prompt based on requested output format
 */
function buildSynthesisPrompt(format: "summary" | "list" | "comparison"): string {
  const base = `Synthesize search results with inline citations using [text](url) format.`;

  switch (format) {
    case "summary":
      return `${base} Provide a cohesive summary paragraph with factual information.`;
    case "list":
      return `${base}
Output a bulleted list where each item is a distinct entity.
Format: • [Name/Title](specific_url) - Key attributes

CRITICAL RULES:
- Each bullet must be a separate, specific item (property, product, post, etc.)
- Use the most specific URL available for each item
- Include concrete details: price, size, features, etc.
- Never merge multiple items into one description
- If working with snippets, still format as distinct items

Example for properties:
• [Sunset Villa](https://airbnb.com/rooms/123) - 4BR/3BA, sleeps 8, $250/night, hot tub, mountain views
• [Downtown Loft](https://airbnb.com/rooms/456) - 2BR, accommodates 8, $180/night, walkable to Pearl Street`;
    case "comparison":
      return `${base} Create a comparison table or structured comparison with specific details.`;
    default:
      return base;
  }
}

// Agent definition
export const targetedResearchAgent = createAgent<ResearchOutput>({
  id: "targeted-research",
  displayName: "Targeted Research Agent",
  version: "1.0.0",
  description:
    "Run targeted web research: executes search with optional domain focus, extracts page content, and returns a cited synthesis.",
  expertise: {
    domains: ["research", "web-search"],
    examples: [
      "Show me popular posts on r/homeautomation about smart locks",
      "Find Airbnbs in Tokyo under $100/night",
      "Compare React vs Vue discussions on r/webdev",
      "Recent r/lupus posts about treatment experiences",
    ],
  },

  handler: async (prompt, { stream, logger, abortSignal }): Promise<ResearchOutput> => {
    const startTime = Date.now();
    const metrics = { parseTime: 0, searchTime: 0, extractTime: 0, synthTime: 0 };

    const apiKey = env.TAVILY_API_KEY;
    if (!apiKey) {
      throw new Error("TAVILY_API_KEY environment variable is required");
    }

    const tavilyClient = tavily({ apiKey });

    try {
      const parseMessage = await generateProgressMessage(
        "parsing",
        { query: prompt },
        "Analyzing query requirements...",
        logger,
        abortSignal,
      );
      stream?.emit({
        type: "data-tool-progress",
        data: { toolName: "Research Agent", content: parseMessage },
      });
      const parseStart = Date.now();
      const parsedQueries = await parseQuery(prompt, logger, abortSignal);
      metrics.parseTime = Date.now() - parseStart;

      logger?.info(`Search request parsed`, {
        queryCount: parsedQueries.queries.length,
        outputFormat: parsedQueries.outputFormat,
      });

      // Initial search progress is now handled in searchWithRetries
      const searchStart = Date.now();
      const searchResults = await searchWithRetries(
        parsedQueries,
        tavilyClient,
        { maxAttempts: 3 },
        stream,
        logger,
        abortSignal,
      );
      metrics.searchTime = Date.now() - searchStart;

      if (searchResults.length === 0) {
        logger?.warn(`No search results found`);
        return "No relevant results found. Try a broader search query.";
      }

      logger?.info(`Search phase complete`, { resultCount: searchResults.length });
      const foundMessage = await generateProgressMessage(
        "searching",
        { resultsFound: searchResults.length, queriesUsed: parsedQueries.queries.length },
        `Found ${searchResults.length} results across ${parsedQueries.queries.length} ${parsedQueries.queries.length === 1 ? "query" : "queries"}`,
        logger,
        abortSignal,
      );
      stream?.emit({
        type: "data-tool-progress",
        data: { toolName: "Research Agent", content: foundMessage },
      });

      // Extraction progress is now handled in extractTopResults
      const extractStart = Date.now();
      const extracted = await extractTopResults(
        searchResults,
        prompt,
        tavilyClient,
        stream,
        logger,
        abortSignal,
      );
      metrics.extractTime = Date.now() - extractStart;

      logger?.info(`Extraction phase complete`, {
        extracted: extracted.successful.length,
        failed: extracted.failed.length,
      });
      const extractCompleteMessage = await generateProgressMessage(
        "extracting",
        { pagesExtracted: extracted.successful.length },
        `Extracted ${extracted.successful.length} pages successfully`,
        logger,
        abortSignal,
      );
      stream?.emit({
        type: "data-tool-progress",
        data: { toolName: "Research Agent", content: extractCompleteMessage },
      });

      const formatDescriptions = { summary: "summary", list: "list", comparison: "comparison" };
      const synthMessage = await generateProgressMessage(
        "synthesizing",
        {
          outputFormat: formatDescriptions[parsedQueries.outputFormat],
          sourceCount: extracted.successful.length,
        },
        `Generating ${formatDescriptions[parsedQueries.outputFormat]} from ${extracted.successful.length} sources...`,
        logger,
        abortSignal,
      );
      stream?.emit({
        type: "data-tool-progress",
        data: { toolName: "Research Agent", content: synthMessage },
      });
      const synthStart = Date.now();
      const synthesis = await synthesizeResults({
        query: prompt,
        parsedQueries,
        searchResults,
        extracted,
        abortSignal,
      });
      metrics.synthTime = Date.now() - synthStart;

      const output: ResearchOutput = {
        prompt,
        parsedQueries,
        synthesis,
        sources: {
          searchResults: searchResults.length,
          extractedCount: extracted.successful.length,
          failedExtractions: extracted.failed.length,
          relevantResults: searchResults.length,
        },
        timing: {
          total: Date.now() - startTime,
          parse: metrics.parseTime,
          search: metrics.searchTime,
          extract: metrics.extractTime,
          synth: metrics.synthTime,
        },
      };

      logger?.info(`Research complete`, { research: JSON.stringify(output) });

      const completeMessage = await generateProgressMessage(
        "synthesizing",
        { totalResults: output.sources.relevantResults },
        "Research complete",
        logger,
        abortSignal,
      );
      stream?.emit({
        type: "data-tool-progress",
        data: { toolName: "Research Agent", content: completeMessage },
      });
      return output;
    } catch (error) {
      logger?.error(`Research agent failed`, {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }
  },
});
