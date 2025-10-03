import type { AtlasTools } from "@atlas/agent-sdk";
import { anthropic } from "@atlas/core";
import type { Logger } from "@atlas/logger";
import { getTodaysDate } from "@atlas/utils";
import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";
import { memoryStore } from "./memory-store.ts";

const FINAL_REPORT_GENERATOR_PROMPT = `Generate research report from completed searches.

Today's date: ${getTodaysDate()}

WORKFLOW:
1. Get all summaries via listResearchSummaries
2. Build report from summaries (200-400 words each)
3. Use readRawData to extract URLs for citations

REPORT FORMAT:
- Direct answer first
- Markdown headings (# title, ## sections)
- Inline citations [1], [2]
- ### Sources section with URLs at end

CITATION FORMAT:
[1] Title: https://url.com

RULES:
- No pleasantries or commentary
- Just facts from research
- Note conflicts if found
- Note gaps if any
- Answer user's specific question only`;

type Params = { logger: Logger; abortSignal?: AbortSignal };

/**
 * Create report generator that synthesizes research into final report.
 */
export function getFinalReportGeneratorSubAgent({ logger, abortSignal }: Params) {
  const tools: AtlasTools = {
    listResearchSummaries: tool({
      description: "Get all summaries and metadata",
      inputSchema: z.object({}),
      execute: () => {
        const summaries = memoryStore.getAllSummaries();
        const tasks = memoryStore.getTasks();
        return { summaries, tasks: tasks.map((t) => ({ taskId: t.taskId, topic: t.topic })) };
      },
    }),

    readRawData: tool({
      description: "Get raw data for URL extraction",
      inputSchema: z.object({
        keys: z.array(z.string()).describe("Specific raw data keys to fetch"),
      }),
      execute: ({ keys }) => {
        if (!keys || keys.length === 0) {
          const allKeys = memoryStore.getRawKeys();
          const results: Record<string, unknown> = {};
          for (const key of allKeys) {
            results[key] = memoryStore.getRaw(key);
          }
          return results;
        }
        const results: Record<string, unknown> = {};
        for (const key of keys) {
          const data = memoryStore.getRaw(key);
          if (data) {
            results[key] = data;
          }
        }
        return results;
      },
    }),
  };

  return {
    /** Generate final report from research summaries */
    async generate(userPrompt: string): Promise<string> {
      const reportPrompt = `Original request: ${userPrompt}

Generate report answering the request.`;

      const { text } = await generateText({
        model: anthropic("claude-3-7-sonnet-latest"),
        system: FINAL_REPORT_GENERATOR_PROMPT,
        prompt: reportPrompt,
        tools,
        maxOutputTokens: 8192,
        stopWhen: stepCountIs(5),
        temperature: 0.4,
        abortSignal,
      });

      logger.debug(`Report generated`, {
        reportLength: text.length,
        summariesUsed: memoryStore.getAllSummaries().length,
      });

      return text;
    },
  };
}
