import { createAgent, err, type OutlineRef, ok, repairToolCall } from "@atlas/agent-sdk";
import {
  collectToolUsageFromSteps,
  extractArtifactRefsFromToolResults,
} from "@atlas/agent-sdk/vercel-helpers";
import { getDefaultProviderOpts, registry, traceModel } from "@atlas/llm";
import { stringifyError } from "@atlas/utils";
import { generateText, stepCountIs } from "ai";
import { z } from "zod";

/**
 * Summary Tool
 *
 * A minimal single-LLM tool intended to summarize content
 * store it in an artifact that can be referenced by other
 * tools and agents.
 */

/** Summary agent returns no data - only artifacts at envelope level */
export const SummaryOutputSchema = z.object({});

type SummaryOutput = z.infer<typeof SummaryOutputSchema>;

export const summaryAgent = createAgent<string, SummaryOutput>({
  id: "get-summary",
  displayName: "Summarizer",
  version: "1.0.0",
  description:
    "Summarizes provided content into a formatted artifact with citations preserved. USE FOR: condensing long-form content, creating TLDRs, producing summary artifacts for downstream agents.",
  constraints:
    "Summarizes content provided in the prompt only. Cannot fetch external content or query databases. For web research, use the research agent.",
  outputSchema: SummaryOutputSchema,
  expertise: { examples: ["Create a summary of the provided content", "Summarize this content"] },
  handler: async (prompt, { tools, logger, abortSignal, stream }) => {
    const system = `
      You are a summary creator that creates user-friendly summaries based on the provided prompt. Always create an artifact with a type equal to 'summary' of the provided content.

      Follow the plan exactly:
      - **Never** fabricate information. Only use the information provided to you.
      - **Avoid** overuse of emoji.
      - **Always** follow the message formatting rules below.
      - If any tool call errors (timeout, authorization, unknown), state the failure briefly and stop.
      - After successfully creating the summary, **always** create an artifact with a type equal to 'summary',
      - You can only return the artifact id, so failure to do this will result in an error.

      ## Message Formatting

      Summaries must follow the following markdown formatting rules:

      **Text Escaping:**
      - Always escape control characters: & → &amp;, < → &lt;, > → &gt;

      **Basic Formatting:**
      - Bold: **text** (asterisks)
      - Italic: _text_ (underscores)
      - Strikethrough: ~text~ (tildes)
      - Line breaks: \\n+      - Block quotes: >quoted text (at line start)
      - Inline code: \`code\` (backticks)
      - Code blocks: \`\`\`code block\`\`\` (triple backticks)
      - Lists: Use - item\\n format (no native list syntax)

      **Links, References, Mentions:**
      - Auto URLs: http://example.com (auto-converted)
      - Custom links: <http://example.com|Link text>
      - Email links: <mailto:user@domain.com|Email User>

      **Important Formatting Constraints:**
      - Text within code blocks ignores other formatting
      - Prefer blocks structure for rich layouts over plain text

      ## Citations in responses
      - ALWAYS Preserve and include all citations/links next to the statements they support.
      - Do not modify or drop links; keep original anchor text and URLs.
      - When summarizing or paraphrasing, carry forward the original citations.
    `;

    try {
      // Progress: planning
      stream?.emit({
        type: "data-tool-progress",
        data: { toolName: "Atlas", content: `Summarizing` },
      });

      const result = await generateText({
        model: traceModel(registry.languageModel("anthropic:claude-haiku-4-5")),
        abortSignal,
        maxRetries: 3,
        messages: [
          { role: "system", content: system, providerOptions: getDefaultProviderOpts("anthropic") },
          { role: "user", content: prompt },
        ],
        tools,
        maxOutputTokens: 2000,
        providerOptions: { anthropic: { thinking: { type: "enabled", budgetTokens: 12000 } } },
        stopWhen: stepCountIs(10),
        experimental_repairToolCall: repairToolCall,
      });

      logger.debug("AI SDK generateText completed", {
        agent: "summary",
        step: "summarize-content",
        usage: result.usage,
      });

      if (result.finishReason === "error") {
        logger.error("summary LLM returned error", {
          phase: "summarize-content",
          finishReason: result.finishReason,
        });
        return err("Failed to generate summary");
      }

      const { steps, toolCalls, toolResults } = result;
      const { assembledToolCalls, assembledToolResults } = collectToolUsageFromSteps({
        steps,
        toolCalls,
        toolResults,
      });

      const artifactRefs = extractArtifactRefsFromToolResults(assembledToolResults);
      logger.debug("summarizer tool success", { artifactRefs });

      if (!artifactRefs || artifactRefs.length === 0) {
        return err("Failed to create summary artifact - the model did not return an artifact id");
      }

      const outlineRefs: OutlineRef[] = [
        {
          service: "internal",
          title: "Plan Summary",
          artifactId: artifactRefs[0]?.id,
          artifactLabel: "View Plan",
        },
      ];

      return ok(
        {},
        {
          toolCalls: assembledToolCalls,
          toolResults: assembledToolResults,
          artifactRefs,
          outlineRefs,
        },
      );
    } catch (error) {
      logger.error("summarizer failed", { error });
      return err(stringifyError(error));
    }
  },
});
