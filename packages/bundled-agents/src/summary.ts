import { createAgent, type ArtifactRef } from "@atlas/agent-sdk";
import {
  collectToolUsageFromSteps,
  extractArtifactRefsFromToolResults,
} from "@atlas/agent-sdk/vercel-helpers";
import { anthropic } from "@atlas/core";
import { generateText, stepCountIs } from "ai";

/**
 * Summary Tool
 *
 * A minimal single-LLM tool intended to summarize content
 * store it in an artifact that can be referenced by other
 * tools and agents.
 */

type Result = { artifactRefs: ArtifactRef[] | null };

export const summaryAgent = createAgent({
  id: "get-summary",
  displayName: "Summarizer",
  version: "1.0.0",
  description: "Create a summary of the provided content",
  expertise: {
    domains: ["summaries"],
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
        data: { toolName: "Atlas", content: `Summarizing...` },
      });

      const { steps, toolCalls, toolResults } = await generateText({
        model: anthropic("claude-sonnet-4-20250514"),
        abortSignal,
        system,
        tools,
        prompt,
        maxOutputTokens: 2000,
        providerOptions: { anthropic: { thinking: { type: "enabled", budgetTokens: 12000 } } },
        stopWhen: stepCountIs(10),
      });

      const { assembledToolResults } = collectToolUsageFromSteps({ steps, toolCalls, toolResults });

      const artifactRefs = extractArtifactRefsFromToolResults(assembledToolResults);
      logger.debug("summarizer tool success", { artifactRefs });

      if (!artifactRefs || artifactRefs.length === 0) {
        throw new Error("Failed to return an artifact id in the response");
      }

      return { artifactRefs };
    } catch (error) {
      logger.debug("summarizer tool failed", { error });

      return { artifactRefs: null };
    }
  },
});
