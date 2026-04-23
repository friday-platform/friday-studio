import process from "node:process";
import type { AgentSessionData, StreamEmitter } from "@atlas/agent-sdk";
import { createFailTool, repairToolCall } from "@atlas/agent-sdk";
import { type PlatformModels, registry, temporalGroundingMessage, traceModel } from "@atlas/llm";
import type { Logger } from "@atlas/logger";
import { generateText, tool } from "ai";
import { Parallel } from "parallel-web";
import { z } from "zod";
import {
  executeSearch,
  type QueryAnalysis,
  QueryAnalysisSchema,
  resolveDefaultRecencyDays,
} from "./search-execution.ts";

const SYNTHESIS_MODEL = "anthropic:claude-sonnet-4-6";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SearchToolContext {
  session: AgentSessionData;
  stream: StreamEmitter | undefined;
  logger: Logger;
  config?: Record<string, unknown>;
  abortSignal?: AbortSignal;
  platformModels: PlatformModels;
}

// ---------------------------------------------------------------------------
// Prompts & Schemas
// ---------------------------------------------------------------------------

const QUERY_ANALYSIS_PROMPT = `Analyze the user's search request and either generate search queries or fail if the request is not researchable.

DECISION TREE:
1. Can this request be answered with web search?
   - NO if: Request is purely personal, requires private data, is a command/action, or has no searchable terms
   - YES if: Contains names, topics, concepts, or questions that could appear on the web

2. If YES: Call analyzeQuery with strategic keyword queries (2-10 queries max)
3. If NO: Call failQuery with clear reason why research cannot proceed

QUERY LIMITS:
- Maximum 10 search queries per request
- If researching many items (e.g., 12 companies), combine related ones or prioritize the most important
- Use broader queries that cover multiple items when possible

RECENCY (recencyDays):
- Breaking news, alerts, urgent monitoring → 2
- Scheduled news monitoring, daily checks → 7
- "Latest" or "recent" developments → 14-30
- Quarterly trends, market analysis → 90
- Annual reviews, yearly roundups → 365
- Timeless topics (how does X work, who is X) → omit recencyDays
- ALWAYS set recencyDays for news/monitoring/alert queries

EXAMPLES:

"Who is Parker Conrad?"
→ analyzeQuery: {"complexity":"simple","searchQueries":["Parker Conrad","Parker Conrad CEO","Parker Conrad Rippling founder"]}

"Compare IBM and Google quantum computing 2024"
→ analyzeQuery: {"complexity":"complex","searchQueries":["IBM quantum 2024","Google quantum AI 2024","IBM vs Google quantum","quantum error correction"],"recencyDays":365}

"OpenAI news from TechCrunch"
→ analyzeQuery: {"complexity":"simple","searchQueries":["OpenAI TechCrunch"],"includeDomains":["techcrunch.com"],"recencyDays":30}

"Monitor news for 15 portfolio companies"
→ analyzeQuery: {"complexity":"complex","searchQueries":["company1 company2 company3 news","company4 company5 company6 news",...], "recencyDays":2} (combine into ≤10 queries)

"Latest AI funding rounds"
→ analyzeQuery: {"complexity":"complex","searchQueries":["AI startup funding 2026","AI series A B funding","AI venture capital deals"],"recencyDays":14}

"What should I have for dinner?"
→ failQuery: {"reason":"Personal preference questions cannot be answered through web research"}

"Send an email to John"
→ failQuery: {"reason":"This is an action request, not a research question"}`;

const ANALYSIS_MODEL = "anthropic:claude-sonnet-4-6";

// ---------------------------------------------------------------------------
// Pipeline steps
// ---------------------------------------------------------------------------

/**
 * Runs query analysis via LLM tool calls, returning the analysis or an error message.
 */
async function analyzeQuery(
  objective: string,
  logger: Logger,
  abortSignal?: AbortSignal,
): Promise<{ ok: true; analysis: QueryAnalysis } | { ok: false; reason: string }> {
  type AnalysisState =
    | { status: "pending" }
    | { status: "success"; analysis: QueryAnalysis }
    | { status: "failed"; reason: string };

  const state: { value: AnalysisState } = { value: { status: "pending" } };

  try {
    const response = await generateText({
      model: traceModel(registry.languageModel(ANALYSIS_MODEL)),
      messages: [
        { role: "system", content: QUERY_ANALYSIS_PROMPT },
        temporalGroundingMessage(),
        { role: "user", content: objective },
      ],
      tools: {
        analyzeQuery: tool({
          description: "Produce the query analysis for the search",
          inputSchema: QueryAnalysisSchema,
          execute: (analysis) => {
            state.value = { status: "success", analysis };
            return { ok: true };
          },
        }),
        failQuery: createFailTool({
          onFail: ({ reason }) => {
            state.value = { status: "failed", reason };
          },
          description:
            "Signal that the query cannot be researched due to missing information or being impossible to search for",
        }),
      },
      toolChoice: "required",
      experimental_repairToolCall: repairToolCall,
      temperature: 0.3,
      maxOutputTokens: 2000,
      abortSignal,
    });

    logger.info("Query analysis response", {
      finishReason: response.finishReason,
      stateStatus: state.value.status,
    });
  } catch (error) {
    logger.error("Query analysis failed", { error, objective });
    return { ok: false, reason: "Failed to analyze query" };
  }

  const analysisState = state.value;

  if (analysisState.status === "failed") {
    logger.warn("Query analysis rejected", { reason: analysisState.reason });
    return { ok: false, reason: analysisState.reason };
  }

  if (analysisState.status === "pending") {
    logger.warn("No analysis tool was called", { objective: objective.slice(0, 500) });
    return { ok: false, reason: "Failed to analyze query" };
  }

  return { ok: true, analysis: analysisState.analysis };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates the `search` AI SDK tool that wraps the Parallel search pipeline.
 *
 * Internally runs: query analysis → parallel search. Returns raw search
 * results (URLs, titles, excerpts, publish dates) as structured JSON so the
 * caller can synthesize or cherry-pick sources itself. ONE call handles an
 * entire research topic — it decomposes into 2-10 parallel queries.
 */
export function createSearchTool(ctx: SearchToolContext) {
  return tool({
    description:
      "Search the web for information. ONE call handles an entire research topic — internally " +
      "decomposes into 2-10 parallel queries and returns raw results (title, URL, excerpts, " +
      "publish date) as structured JSON. The caller synthesizes the answer. Pass your full " +
      "research question as the objective (e.g. 'What are new titanium and carbon gravel bikes " +
      "with >2 inch tire clearance?'). Do NOT call multiple times for different facets of the " +
      "same topic.",
    inputSchema: z.object({
      objective: z
        .string()
        .describe("The search query or research goal — what you want to find out"),
    }),
    execute: async ({ objective }) => {
      const { stream, logger, config, abortSignal } = ctx;

      logger.info(`[search] ${objective.slice(0, 120)}`);

      const gatewayUrl = process.env.FRIDAY_GATEWAY_URL;
      const atlasKey = process.env.ATLAS_KEY;
      const apiKey = process.env.PARALLEL_API_KEY;

      if (!gatewayUrl && !apiKey) {
        return "Search unavailable: FRIDAY_GATEWAY_URL or PARALLEL_API_KEY is required";
      }
      if (gatewayUrl && !atlasKey) {
        return "Search unavailable: ATLAS_KEY is required when using FRIDAY_GATEWAY_URL";
      }

      const parallelClient = new Parallel({
        apiKey: apiKey ?? "",
        baseURL: gatewayUrl ? `${gatewayUrl}/v1/parallel` : undefined,
        defaultHeaders: gatewayUrl ? { Authorization: `Bearer ${atlasKey}` } : undefined,
      });

      // Phase 1: Analyze query
      stream?.emit({
        type: "data-tool-progress",
        data: { toolName: "Web Search", content: "Analyzing query..." },
      });

      const analysisResult = await analyzeQuery(objective, logger, abortSignal);
      if (!analysisResult.ok) {
        return analysisResult.reason;
      }

      let { analysis } = analysisResult;

      // Apply defaultRecencyDays from workspace config when the LLM didn't set one
      if (!analysis.recencyDays) {
        const defaultRecencyDays = resolveDefaultRecencyDays(config);
        if (defaultRecencyDays) {
          analysis = { ...analysis, recencyDays: defaultRecencyDays };
          logger.info("Applied defaultRecencyDays from config", {
            recencyDays: defaultRecencyDays,
          });
        }
      }

      // Phase 2: Execute search
      stream?.emit({
        type: "data-tool-progress",
        data: {
          toolName: "Web Search",
          content: `Searching ${analysis.searchQueries.length} queries...`,
        },
      });

      logger.info(`[search] running ${analysis.searchQueries.length} queries`);

      const searchResult = await executeSearch(
        parallelClient,
        ctx.platformModels,
        objective,
        analysis,
        logger,
      );

      logger.info(`[search] got ${searchResult.results.length} results`);

      if (searchResult.results.length === 0) {
        logger.warn("No search results returned");
        return "No relevant results found for your query";
      }

      // Phase 3: Lightweight synthesis — a single concise LLM pass that
      // produces a structured summary + source list. This is cheaper than
      // letting the calling agent wander across 10+ follow-up tool calls
      // trying to feel "done."
      stream?.emit({
        type: "data-tool-progress",
        data: { toolName: "Web Search", content: "Synthesizing results..." },
      });

      const context = searchResult.results
        .map((r, i) => {
          const excerpts = r.excerpts?.join("\n") ?? "";
          return `[${i + 1}] ${r.title || "Untitled"}\nURL: ${r.url}\n${r.publish_date ? `Published: ${r.publish_date}\n` : ""}${excerpts}`;
        })
        .join("\n\n---\n\n");

      const synthesis = await generateText({
        model: traceModel(registry.languageModel(SYNTHESIS_MODEL)),
        abortSignal,
        messages: [
          {
            role: "system",
            content: `Answer the user's question using ONLY the provided search results. Be concise but complete — 3-8 bullet points or a short paragraph. Cite sources inline with [N] markers. After the answer, list every source with its full URL, site name, and page title. NEVER omit a source URL.`,
          },
          temporalGroundingMessage(),
          { role: "user", content: `Question: ${objective}\n\nSources:\n${context}` },
        ],
        temperature: 0.3,
        maxOutputTokens: 4096,
      });

      return JSON.stringify({
        searchId: searchResult.search_id,
        summary: synthesis.text,
        sources: searchResult.results.map((r) => ({
          title: r.title,
          url: r.url,
          publishDate: r.publish_date,
        })),
        usage: searchResult.usage,
      });
    },
  });
}
