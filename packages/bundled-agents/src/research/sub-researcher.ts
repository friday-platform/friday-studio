/**
 * Sub-agent that executes individual research tasks.
 */

import { anthropic } from "@ai-sdk/anthropic";
import type { AgentTelemetryConfig, AtlasTool } from "@atlas/agent-sdk";
import type { Logger } from "@atlas/logger";
import { getTodaysDate } from "@atlas/utils";
import { withSpan } from "@atlas/utils/telemetry.server";
import type { TavilyClient } from "@tavily/core";
import { stepCountIs, streamText, tool } from "ai";
import { z } from "zod";
import { memoryStore } from "./memory-store.ts";
import { createSubAgentTools } from "./tools/search-tools.ts";
import type { ResearchDepth } from "./types.ts";

/** Create prompt for sub-agent based on depth */
function createSubAgentPrompt(depth: ResearchDepth): string {
  const depthConfig = {
    quick: {
      maxSearches: 1,
      strategy: "Single broad search - follow-up only if critical",
      stopCondition: "after 1 search (2 max)",
    },
    standard: {
      maxSearches: 2,
      strategy: "Initial search, one targeted follow-up if needed",
      stopCondition: "80% confidence or 2 searches",
    },
    deep: {
      maxSearches: 4,
      strategy: "Multi-angle research",
      stopCondition: "high confidence or 4 searches",
    },
  };

  const config = depthConfig[depth];

  return `Research sub-agent conducting ${depth} research.

Today's date: ${getTodaysDate()}

${depth.toUpperCase()} MODE:
- Max ${config.maxSearches} search(es)
- Strategy: ${config.strategy}
- Stop: ${config.stopCondition}

TASK: Search your assigned topic. Tools auto-store results.

TOOLS:
- tavily_search: Web search with auto-summarization
- tavily_extract: URL content extraction

RULES:
1. After EACH search: "Can I answer the question?"
2. Stop if confident
3. Hard stop at ${config.maxSearches} search(es)
4. Each search must target specific gaps

STRATEGY:
Search 1: Broad overview
${config.maxSearches > 1 ? "Search 2: Specific gaps from search 1" : ""}
${config.maxSearches > 2 ? "Search 3+: Very specific questions" : ""}

After research, provide synthesis and any gaps.`;
}

const executeResearchSchema = z.object({
  topic: z.string().describe("Research topic"),
  depth: z.enum(["quick", "standard", "deep"]).describe("Depth level (determines search count)"),
});

type Params = {
  tavily: TavilyClient;
  logger: Logger;
  telemetry?: AgentTelemetryConfig;
  abortSignal?: AbortSignal;
};

/**
 * Create a sub-agent tool that executes research tasks.
 * Each call spawns a new sub-agent with its own search tools.
 */
export function getResearcherSubAgent({
  tavily,
  logger,
  telemetry,
  abortSignal,
}: Params): AtlasTool {
  return tool({
    description: "Execute focused research task",
    inputSchema: executeResearchSchema,
    execute: async ({ topic, depth }) => {
      const taskId = memoryStore.generateId("task");

      logger.debug(`Starting research sub-agent`, { topic, depth, taskId });

      const synthesis = await withSpan(
        telemetry?.tracer,
        "research-subtask",
        { "research.topic": topic, "research.id": taskId },
        async () => {
          const subAgentTools = createSubAgentTools({ tavily, logger, abortSignal });

          logger.debug("Created sub-agent tools", { taskId });
          const maxSteps = {
            quick: 3, // 1-2 searches + response
            standard: 5, // 2-3 searches + response
            deep: 8, // 4-5 searches + response
          }[depth];

          const result = streamText({
            model: anthropic("claude-3-5-haiku-latest"),
            system: createSubAgentPrompt(depth),
            prompt: `Research task: ${topic}`,
            tools: subAgentTools,
            maxRetries: 2,
            stopWhen: stepCountIs(maxSteps),
            maxOutputTokens: 8192,
            temperature: 0.3,
            abortSignal,
            experimental_telemetry: telemetry ? { isEnabled: true, ...telemetry } : undefined,
          });

          const synthesis = await result.text;
          return synthesis;
        },
      );

      memoryStore.addTask({ taskId, topic });

      logger.debug(`Sub-agent completed`, { topic, depth, taskId });

      return { taskId, synthesis };
    },
  });
}
