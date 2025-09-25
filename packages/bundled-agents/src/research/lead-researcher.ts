/**
 * Lead researcher that coordinates parallel sub-agents.
 * Each sub-agent searches independently, results are stored for final report.
 */

import { anthropic } from "@ai-sdk/anthropic";
import { createAgent } from "@atlas/agent-sdk";
import type { Logger } from "@atlas/logger";
import { fail, getTodaysDate, type Result, success } from "@atlas/utils";
import { tavily as createTavily } from "@tavily/core";
import { generateObject, generateText, hasToolCall, stepCountIs, streamText, tool } from "ai";
import { z } from "zod/v4";
import { getFinalReportGeneratorSubAgent } from "./final-report-generator.ts";
import { memoryStore } from "./memory-store.ts";
import { getResearcherSubAgent } from "./sub-researcher.ts";
import { type ResearchDepth, researchDepth } from "./types.ts";

const ResearchTaskSchema = z.object({
  depth: researchDepth,
  researchQuestion: z
    .string()
    .meta({ description: "Cleaned research question from user's perspective" }),
});

// Track previously generated messages to avoid repetition
const previousMessages = new Set<string>();

/**
 * Generates personalized progress messages for research operations
 */
async function generateResearchProgress(
  stage: string,
  context: unknown,
  fallback: string,
  logger: Logger,
  abortSignal?: AbortSignal,
): Promise<string> {
  try {
    const contextStr = typeof context === "string" ? context : JSON.stringify(context, null, 2);
    const recentMessages = Array.from(previousMessages).slice(-5).join(", ");

    const stageGuidance: Record<string, string> = {
      analyzing: `Extract the core topic.
Examples:
- "Examining AI safety"
- "Understanding meeting participants"`,

      starting: `Extract specific research focus.
Examples:
- "Investigating Parker Conrad"
- "Exploring quantum algorithms"
- "Surveying market trends"`,

      reporting: `Extract report focus.
Examples:
- "Compiling founder analysis"
- "Finalizing research brief"`,
    };

    const guidance = stageGuidance[stage] || "Generate a status update for this research operation";

    const { text } = await generateText({
      model: anthropic("claude-3-5-haiku-latest"),
      abortSignal,
      system: `Generate a research progress update.

<constraints>
- Maximum 4 words
- Start with active verb
- Be specific about WHAT is being researched
- Match the research topic/question in context
- No generic phrases like "conducting research"
- Avoid repetition - use different verbs and phrasings than recent messages
</constraints>

<stage_guidance>
${guidance}
</stage_guidance>`,
      prompt: `<stage>${stage}</stage>

<context>
${contextStr.slice(0, 500)}
</context>

<recent_messages>
${recentMessages || "none"}
</recent_messages>

<task>
Generate a UNIQUE progress update about this research activity.
Must be different from recent messages - vary the verb and phrasing.
Return ONLY the progress text, no explanations.
</task>`,
      temperature: 0.5,
      maxOutputTokens: 50,
    });
    const message = text.trim();
    previousMessages.add(message);
    return message;
  } catch (error) {
    logger.warn(`Failed to generate progress message`, { error, stage });
    return fallback;
  }
}

export const RESEARCH_TOPIC_WRITER_PROMPT = `Task: Analyze research request and determine appropriate depth.
Purpose: Convert user's request into actionable research parameters.
Today's date: ${getTodaysDate()}

<decision_tree>
1. Identify request type:
   - Information gathering → Check for depth signals
   - Comparison → Standard (unless specified)
   - Analysis → Check for exhaustive signals

2. Check for depth signals:
   Quick signals (return "quick"):
   - "collect info", "anything I should know"
   - "meeting prep", "background for meeting"
   - Time constraint mentioned (< 5 minutes)
   - Single fact request

   Deep signals (return "deep"):
   - "deep dive", "comprehensive", "exhaustive"
   - "analyze thoroughly", "all aspects"
   - Academic or technical analysis
   - Multi-factor comparison (3+ items)

   Default: Return "standard"

3. Clean the research question:
   - Preserve ALL user details
   - Use first-person perspective
   - Fix grammar only
   - DO NOT add scope or intensity
</decision_tree>

<examples>
  <example>
    Input: "collect some info about who I'm meeting with from Anthropic"
    Depth: quick
    Question: "Who am I meeting with from Anthropic?"
  </example>

  <example>
    Input: "Research the latest AI safety developments"
    Depth: standard
    Question: "What are the latest AI safety developments?"
  </example>

  <example>
    Input: "Deep dive into how transformers work vs RNNs for sequence modeling"
    Depth: deep
    Question: "How do transformers work versus RNNs for sequence modeling?"
  </example>
</examples>

<output_format>
{
  "depth": "quick" | "standard" | "deep",
  "researchQuestion": "Cleaned question preserving user intent"
}
</output_format>`;

/** Create supervisor prompt based on research depth */
function createSupervisorPrompt(depth: ResearchDepth): string {
  const depthGuidance = {
    quick: `QUICK MODE:
- Pass depth="quick" to all conductResearch calls
- Up to 3-4 parallel tasks for independent topics
- 1-2 searches max per task
- Key facts only: who, what, recent news`,
    standard: `STANDARD MODE:
- Pass depth="standard" to all conductResearch calls
- Maximum 3-4 research tasks
- Balanced depth and breadth`,
    deep: `DEEP MODE:
- Pass depth="deep" to all conductResearch calls
- Maximum 5 research tasks
- Multiple angles and detailed analysis`,
  };

  return `Research supervisor coordinating parallel research tasks.

Today's date: ${getTodaysDate()}

${depthGuidance[depth]}

WORKFLOW:
1. Parse the question for actionable research topics
2. IF the question lacks specific searchable details (names, companies, topics):
   - Call researchFailed with clear reason why research cannot proceed
   - STOP - do not continue or attempt to answer
3. Identify distinct topics in the question
4. Delegate using conductResearch with depth parameter
5. Read synthesis from each sub-agent
6. Check if question is answered
7. Delegate more if critical gaps exist
8. Call researchComplete when done

STRATEGY:
- Simple queries: Single task
- Comparisons: One task per item
- Complex topics: 2-4 subtasks

IMPORTANT:
- If question is not researchable (too vague, missing details), call researchFailed immediately
- Call conductResearch multiple times in one message for parallel execution
- Each task must be self-contained
- Read each synthesis to assess completeness
- Only orchestrate, don't synthesize
- Always call researchComplete when satisfied (or researchFailed if not possible)`;
}

type ResearchAgentResult = Result<
  // Summary of the research findings
  { summary: string },
  // Reason for failure
  { reason: string }
>;

export const researchAgent = createAgent<ResearchAgentResult>({
  id: "research",
  displayName: "Research Agent",
  version: "1.0.0",
  description: "Performs web research.",
  expertise: {
    domains: ["research", "web-search"],
    examples: [
      "Research the latest developments in quantum computing",
      "Compare different programming frameworks for web development",
      "Find the best restaurants in Paris with Michelin stars",
      "Analyze recent AI safety research from major labs",
      "Gather information about renewable energy trends in 2024",
      "Deep dive into blockchain scalability solutions",
    ],
  },

  handler: async (prompt, { logger, stream, abortSignal, telemetry }) => {
    const apiKey = Deno.env.get("TAVILY_API_KEY");
    if (!apiKey) {
      throw new Error("TAVILY_API_KEY environment variable is required");
    }

    // Initialize memory store
    const tavily = createTavily({ apiKey });

    // Track failure state for the agent.
    const failureState = { failed: false, reason: "" };

    const finalReportGenerator = getFinalReportGeneratorSubAgent({ abortSignal, logger });
    const researcherAgent = getResearcherSubAgent({ tavily, logger, abortSignal, telemetry });

    try {
      logger.info(`Starting fast research agent`, { prompt });

      // Clear previous messages for new research session
      previousMessages.clear();

      const analyzingMessage = await generateResearchProgress(
        "analyzing",
        prompt,
        "Analyzing requirements...",
        logger,
        abortSignal,
      );

      stream?.emit({
        type: "data-tool-progress",
        data: { toolName: "Fast Research", content: analyzingMessage },
      });

      const { object: researchTask } = await generateObject({
        model: anthropic("claude-3-7-sonnet-latest"),
        system: RESEARCH_TOPIC_WRITER_PROMPT,
        prompt: prompt,
        schema: ResearchTaskSchema,
        temperature: 0.3,
        maxOutputTokens: 500,
        abortSignal,
      });

      logger.info(`Research task analyzed`, {
        depth: researchTask.depth,
        original: prompt,
        processed: researchTask.researchQuestion,
      });

      /** Execute research with supervisor */
      const result = streamText({
        model: anthropic("claude-sonnet-4-20250514"),
        system: createSupervisorPrompt(researchTask.depth),
        prompt: researchTask.researchQuestion,
        tools: {
          conductResearch: researcherAgent,
          researchComplete: tool({
            description: "Signal research complete",
            inputSchema: z.object({}),
            execute: () => {
              logger.debug("Research marked as complete by supervisor");
              return { status: "complete" };
            },
          }),
          researchFailed: tool({
            description:
              "Signal research cannot be completed due to missing information or other blocker",
            inputSchema: z.object({
              reason: z.string().describe("Why the research cannot be completed"),
            }),
            execute: ({ reason }) => {
              logger.warn("Research marked as failed by supervisor", { reason });
              failureState.failed = true;
              failureState.reason = reason;
              return { status: "failed", reason };
            },
          }),
        },
        maxOutputTokens: 8192,
        abortSignal,
        experimental_telemetry: telemetry
          ? {
              isEnabled: true,
              tracer: telemetry.tracer,
              recordInputs: telemetry.recordInputs,
              recordOutputs: telemetry.recordOutputs,
            }
          : undefined,
        stopWhen: [stepCountIs(20), hasToolCall("researchComplete"), hasToolCall("researchFailed")],
        onChunk: async ({ chunk }) => {
          if (chunk.type === "tool-call") {
            if (chunk.toolName === "conductResearch") {
              const startingMessage = await generateResearchProgress(
                "starting",
                chunk.input,
                `Starting research: ${chunk.input.topic}`,
                logger,
                abortSignal,
              );

              stream?.emit({
                type: "data-tool-progress",
                data: { toolName: "Fast Research", content: startingMessage },
              });
            }
          }
        },
      });

      const supervisorStatus = await result.text;

      logger.debug(`Supervisor completed orchestration`, {
        status: supervisorStatus,
        summaryCount: memoryStore.getAllSummaries().length,
      });

      // Check if research failed
      if (failureState.failed) {
        logger.warn("Research aborted due to failure", { reason: failureState.reason });
        return fail({ reason: failureState.reason });
      }

      // Check if we have any summaries
      const summaryCount = memoryStore.getAllSummaries().length;
      if (summaryCount === 0) {
        logger.warn("No research summaries generated");
        return fail({ reason: "Research completed but no results were found" });
      }

      const reportingMessage = await generateResearchProgress(
        "reporting",
        researchTask.researchQuestion,
        "Generating report...",
        logger,
        abortSignal,
      );

      stream?.emit({
        type: "data-tool-progress",
        data: { toolName: "Fast Research", content: reportingMessage },
      });

      const finalReport = await finalReportGenerator.generate(prompt);

      logger.info(`Fast research completed`, {
        summaryCount: memoryStore.getAllSummaries().length,
        reportLength: finalReport.length,
      });

      return success({ summary: finalReport });
    } catch (error) {
      logger.error(`Fast research agent failed`, { error });
      throw error;
    }
  },
});
