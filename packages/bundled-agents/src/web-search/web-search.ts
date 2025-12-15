import process from "node:process";
import { createAgent, repairJson } from "@atlas/agent-sdk";
import { client, parseResult } from "@atlas/client/v2";
import { registry, smallLLM } from "@atlas/llm";
import { fail, getTodaysDate, type Result, success } from "@atlas/utils";
import { generateObject, generateText, tool } from "ai";
import { wrapAISDKModel } from "evalite/ai-sdk";
import { Parallel } from "parallel-web";
import { z } from "zod";
import { executeSearch } from "./search-tool.ts";
import { type QueryAnalysis, QueryAnalysisSchema, type SearchResult } from "./types.ts";

export type WebSearchAgentResult = Result<
  { summary: string; artifactRef: { id: string; type: string; summary: string } },
  { reason: string }
>;

export type {
  QueryAnalysis,
  SearchResult,
} from "./types.ts";

async function generateResponseProgress(
  prompt: string,
  abortSignal?: AbortSignal,
): Promise<string> {
  return await smallLLM({
    system: `Output a single response status line (≤40 chars, -ing verb, no punctuation).
      When multiple items: describe the category or purpose, not individual names.

      Examples:
      "Compare AWS and GCP pricing" → "Comparing cloud pricing"
      "What is Parker Conrad known for?" → "Researching Parker Conrad"
      "Latest quantum computing news" → "Finding quantum computing news"
      "Research 3 people for today's meetings" → "Researching meeting contacts"
      "Find info on Rippling, Replit, Socket" → "Researching portfolio companies"`,
    prompt,
    abortSignal,
    maxOutputTokens: 50,
  });
}

async function generateResponseDescription(
  prompt: string,
  abortSignal?: AbortSignal,
): Promise<string> {
  return await smallLLM({
    system: `
    Generate a concise response description (≤40 chars). Absolutely no markdown!

    Examples:
      When multiple items: describe the category or purpose, not individual names.

      "Compare AWS and GCP pricing" → "Cloud Pricing Comparison"
      "What is Parker Conrad known for?" → "Parker Conrad Background"
      "Research 3 people for today's meetings" -> "Today's meeting schedule"
      "Latest quantum computing news" → "Quantum Computing News"
      "How does React's virtual DOM work?" → "React Virtual DOM Overview"`,
    prompt,
    abortSignal,
    maxOutputTokens: 50,
  });
}

const QUERY_ANALYSIS_PROMPT = `Analyze the user's search request and either generate search queries or fail if the request is not researchable.

DECISION TREE:
1. Can this request be answered with web search?
   - NO if: Request is purely personal, requires private data, is a command/action, or has no searchable terms
   - YES if: Contains names, topics, concepts, or questions that could appear on the web

2. If YES: Call analyzeQuery with strategic keyword queries
3. If NO: Call failQuery with clear reason why research cannot proceed

EXAMPLES:

"Who is Parker Conrad?"
→ analyzeQuery: {"complexity":"simple","searchQueries":["Parker Conrad","Parker Conrad CEO","Parker Conrad Rippling founder"]}

"Compare IBM and Google quantum computing 2024"
→ analyzeQuery: {"complexity":"complex","searchQueries":["IBM quantum 2024","Google quantum AI 2024","IBM vs Google quantum","quantum error correction"]}

"OpenAI news from TechCrunch"
→ analyzeQuery: {"complexity":"simple","searchQueries":["OpenAI TechCrunch"],"includeDomains":["techcrunch.com"]}

"What should I have for dinner?"
→ failQuery: {"reason":"Personal preference questions cannot be answered through web research"}

"Send an email to John"
→ failQuery: {"reason":"This is an action request, not a research question"}`;

const ResponseSchema = z.object({
  title: z.string().describe("Concise title for the report (≤40 chars). No markdown."),
  response: z.string().describe(`
      - Full markdown response of the research.
      - NEVER use inline citations [N] when referencing information.
      - NEVER append a list of citations or sources to the end of the report.
      - Use proper headings for sections
    `),
  sources: z
    .array(
      z.object({
        siteName: z.string().describe("Website/domain name (e.g. 'Serious Eats', 'Wikipedia')"),
        pageTitle: z.string().describe("Page title or heading"),
        url: z.string().describe("Complete URL of the source (do not omit or shorten)"),
      }),
    )
    .describe("Sources found in the search"),
  summary: z.string().describe("2-3 sentence summary. Direct and factual, no fluff."),
});

type ResponseOutput = z.infer<typeof ResponseSchema>;

/**
 * Generates a web search response with inline citations and an executive summary.
 */
async function generateResponse(
  originalPrompt: string,
  searchResult: SearchResult,
  abortSignal?: AbortSignal,
): Promise<ResponseOutput> {
  const context = searchResult.results
    .map((r, i) => {
      const excerpts = r.excerpts?.join("\n\n") || "";
      return `[${i + 1}] ${r.title || "Untitled"} (${r.url})
${r.publish_date ? `Published: ${r.publish_date}` : ""}
${excerpts}`;
    })
    .join("\n\n---\n\n");

  const result = await generateObject({
    model: wrapAISDKModel(registry.languageModel("groq:openai/gpt-oss-120b")),
    abortSignal,
    schema: ResponseSchema,
    experimental_repairText: repairJson,
    messages: [
      {
        role: "system",
        content: `
        Generate a full report answering the question and using the provided sources.

        Requirements:
        - NEVER add inline citatations into the content. You may, when necessary add webpage context (ex: See: [Source Page Title])
        - NEVER include a sources/references section at the end of the report,
        - ALWAYS include each source in the sources array with siteName, pageTitle, and full url`,
      },
      { role: "system", content: `Today: ${getTodaysDate()}` },
      { role: "user", content: `Question: ${originalPrompt}\n\nSources:\n${context}` },
    ],
    temperature: 0.3,
    maxOutputTokens: 8192,
  });

  return {
    title: result.object.title,
    response: result.object.response,
    sources: result.object.sources,
    summary: result.object.summary,
  };
}

export const webSearchAgent = createAgent<string, WebSearchAgentResult>({
  id: "research",
  displayName: "Web Search",
  version: "2.0.0",
  description:
    "Performs comprehensive web research. Works best when given the user's broader goal, decision context, or how the information will be used. Handles complex multi-faceted research in a single call.",
  expertise: {
    domains: ["research", "web-search"],
    examples: [
      "I'm evaluating cloud providers for our startup. Research AWS, GCP, and Azure's serverless offerings, pricing models, and cold start performance as of 2024.",
      "I'm writing a technical blog post about Rust's ownership model. Find authoritative documentation, common misconceptions from community discussions, and recent improvements.",
      "Our team is deciding whether to adopt GraphQL. Compare it to REST for a high-traffic e-commerce API, focusing on performance trade-offs and tooling maturity.",
      "I'm preparing investor materials for Q1 2025. Research recent regulatory announcements from the Federal Reserve and SEC about digital asset regulations and banking partnerships with crypto firms.",
    ],
  },

  handler: async (prompt, { logger, stream, abortSignal, session }) => {
    logger.info("Starting web search agent", { prompt });

    const apiKey = process.env.PARALLEL_API_KEY;
    if (!apiKey) {
      throw new Error("PARALLEL_API_KEY environment variable is required");
    }
    const parallelClient = new Parallel({ apiKey });

    stream?.emit({
      type: "data-tool-progress",
      data: { toolName: "Web Search", content: "Analyzing query" },
    });

    // Tagged union for analysis result - tools mutate this during execution
    // Wrapped in object to prevent TS control flow from narrowing incorrectly
    type AnalysisState =
      | { status: "pending" }
      | { status: "success"; analysis: QueryAnalysis }
      | { status: "failed"; reason: string };

    const state: { value: AnalysisState } = { value: { status: "pending" } };

    try {
      await generateText({
        model: wrapAISDKModel(registry.languageModel("groq:openai/gpt-oss-120b")),
        messages: [
          { role: "system", content: QUERY_ANALYSIS_PROMPT },
          { role: "system", content: `Today's date: ${getTodaysDate()}` },
          { role: "user", content: prompt },
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
          failQuery: tool({
            description:
              "Signal that the query cannot be researched due to missing information or being impossible to search for",
            inputSchema: z.object({
              reason: z.string().describe("Why the query cannot be researched"),
            }),
            execute: ({ reason }) => {
              state.value = { status: "failed", reason };
              return { ok: false };
            },
          }),
        },
        toolChoice: "required",
        temperature: 0.3,
        maxOutputTokens: 2000,
        abortSignal,
      });
    } catch (error) {
      logger.error("Query analysis failed", { error, prompt });
      return fail({ reason: "Failed to analyze query" });
    }

    const analysisState = state.value;

    if (analysisState.status === "failed") {
      logger.warn("Query analysis failed", { reason: analysisState.reason });
      return fail({ reason: analysisState.reason });
    }

    if (analysisState.status === "pending") {
      logger.warn("No analysis tool was called");
      return fail({ reason: "Failed to analyze query" });
    }

    const { analysis } = analysisState;

    const [progressMessage, reportDescription] = await Promise.all([
      generateResponseProgress(prompt, abortSignal),
      generateResponseDescription(prompt, abortSignal),
    ]);

    stream?.emit({
      type: "data-tool-progress",
      data: { toolName: "Web Search", content: progressMessage },
    });

    const searchResult = await executeSearch(parallelClient, prompt, analysis, logger);

    if (searchResult.results.length === 0) {
      logger.warn("No search results returned");
      return fail({ reason: "No relevant results found for your query" });
    }

    const {
      title,
      response: webResponse,
      sources,
      summary,
    } = await generateResponse(prompt, searchResult, abortSignal);

    const response = await parseResult(
      client.artifactsStorage.index.$post({
        json: {
          title,
          data: { type: "web-search", version: 1, data: { response: webResponse, sources } },
          summary,
          workspaceId: session.workspaceId,
          chatId: session.streamId,
        },
      }),
    );

    if (!response.ok) {
      throw new Error(`Failed to create artifact: ${JSON.stringify(response.error)}`);
    }

    const artifactId = response.data.artifact.id;

    stream?.emit({
      type: "data-outline-update",
      data: {
        id: "web-search",
        title: "Search Result",
        content: reportDescription,
        timestamp: Date.now(),
        artifactId,
        artifactLabel: "View Report",
      },
    });

    logger.info("Research completed", { artifactId });

    return success({ summary, artifactRef: { id: artifactId, type: "web-search", summary } });
  },
});
