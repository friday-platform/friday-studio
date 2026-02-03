import { createAgent, repairToolCall } from "@atlas/agent-sdk";
import {
  collectToolUsageFromSteps,
  extractArtifactRefsFromToolResults,
} from "@atlas/agent-sdk/vercel-helpers";
import { getDefaultProviderOpts, registry } from "@atlas/llm";
import { generateText, stepCountIs } from "ai";
import { z } from "zod";
import { ArtifactRefsSchema, OutlineRefsSchema } from "./shared-schemas.ts";

/**
 * Summary Tool
 *
 * A minimal single-LLM tool intended to summarize content
 * store it in an artifact that can be referenced by other
 * tools and agents.
 */

export const SummaryOutputSchema = z.object({
  artifactRefs: ArtifactRefsSchema.nullable().describe(
    "Summary artifact references (null on failure)",
  ),
  outlineRefs: OutlineRefsSchema.optional(),
});

type Result = z.infer<typeof SummaryOutputSchema>;

export const summaryAgent = createAgent({
  id: "get-summary",
  displayName: "Summarizer",
  version: "1.0.0",
  description: "Create a summary of the provided content",
  expertise: {
    domains: ["summaries", "summarization", "tldr"],
    examples: ["Create a summary of the provided content", "Summarize this content"],
  },
  handler: async (prompt, { tools, logger, abortSignal, stream }): Promise<Result> => {
    try {
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

      // Progress: planning
      stream?.emit({
        type: "data-tool-progress",
        data: { toolName: "Atlas", content: `Summarizing` },
      });

      const result = await generateText({
        model: registry.languageModel("anthropic:claude-haiku-4-5"),
        abortSignal,
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

      const { steps, toolCalls, toolResults } = result;
      const { assembledToolResults } = collectToolUsageFromSteps({ steps, toolCalls, toolResults });

      const artifactRefs = extractArtifactRefsFromToolResults(assembledToolResults);
      logger.debug("summarizer tool success", { artifactRefs });

      if (!artifactRefs || artifactRefs.length === 0) {
        throw new Error("Failed to return an artifact id in the response");
      }

      return {
        artifactRefs,
        outlineRefs: [
          {
            service: "internal",
            title: "Plan Summary",
            artifactId: artifactRefs?.[0]?.id,
            artifactLabel: "View Plan",
          },
        ],
      };
    } catch (error) {
      logger.debug("summarizer tool failed", { error });

      return { artifactRefs: null };
    }
  },
});
