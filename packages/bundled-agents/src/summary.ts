import { type ArtifactRef, createAgent } from "@atlas/agent-sdk";
import {
  collectToolUsageFromSteps,
  extractArtifactRefsFromToolResults,
} from "@atlas/agent-sdk/vercel-helpers";
import { getDefaultProviderOpts, registry } from "@atlas/llm";
import { generateText, stepCountIs } from "ai";

/**
 * Summary Tool
 *
 * A minimal single-LLM tool intended to summarize content
 * store it in an artifact that can be referenced by other
 * tools and agents.
 */

type Result = { artifactRefs: ArtifactRef[] | null };

const icon =
  "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTYiIGhlaWdodD0iMTYiIHZpZXdCb3g9IjAgMCAxNiAxNiIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPGcgb3BhY2l0eT0iMC41Ij4KPHJlY3Qgd2lkdGg9IjE2IiBoZWlnaHQ9IjE2IiBmaWxsPSJ3aGl0ZSIgc3R5bGU9ImZpbGw6d2hpdGU7ZmlsbC1vcGFjaXR5OjE7Ii8+CjxwYXRoIGQ9Ik0xMS40MDA0IDIuMjYzNjdDMTIuNjkxMiAyLjI2Mzg4IDEzLjczODMgMy4zMTA3MyAxMy43MzgzIDQuNjAxNTZWMTEuNDAxNEMxMy43MzgxIDEyLjY5MiAxMi42OTEgMTMuNzM5IDExLjQwMDQgMTMuNzM5M0g0LjYwMDU5QzMuMzA5NzUgMTMuNzM5MyAyLjI2MjkxIDEyLjY5MjIgMi4yNjI3IDExLjQwMTRWNC42MDE1NkMyLjI2MjcgMy4zMTA2IDMuMzA5NjIgMi4yNjM2NyA0LjYwMDU5IDIuMjYzNjdIMTEuNDAwNFpNNC42MDA1OSAzLjUzOTA2QzQuMDEzNzggMy41MzkwNiAzLjUzODA5IDQuMDE0NzYgMy41MzgwOSA0LjYwMTU2VjExLjQwMTRDMy41MzgzIDExLjk4OCA0LjAxMzkxIDEyLjQ2MzkgNC42MDA1OSAxMi40NjM5SDExLjQwMDRDMTEuOTg2OSAxMi40NjM3IDEyLjQ2MjcgMTEuOTg3OSAxMi40NjI5IDExLjQwMTRWNC42MDE1NkMxMi40NjI5IDQuMDE0ODkgMTEuOTg3IDMuNTM5MjcgMTEuNDAwNCAzLjUzOTA2SDQuNjAwNTlaTTguODQ5NjEgOS45MTMwOUM5LjIwMTYzIDkuOTEzMDkgOS40ODcyIDEwLjE5ODggOS40ODczIDEwLjU1MDhDOS40ODczIDEwLjkwMjkgOS4yMDE2OSAxMS4xODg1IDguODQ5NjEgMTEuMTg4NUg1LjQ0OTIyQzUuMDk3NSAxMS4xODgxIDQuODEyNSAxMC45MDI2IDQuODEyNSAxMC41NTA4QzQuODEyNjEgMTAuMTk5IDUuMDk3NTYgOS45MTM1MSA1LjQ0OTIyIDkuOTEzMDlIOC44NDk2MVpNMTAuNTQ5OCA3LjM2MzI4QzEwLjkwMTkgNy4zNjMyOCAxMS4xODc1IDcuNjQ4ODkgMTEuMTg3NSA4LjAwMDk4QzExLjE4NzUgOC4zNTMwNiAxMC45MDE5IDguNjM4NjcgMTAuNTQ5OCA4LjYzODY3SDUuNDUwMkM1LjA5ODIgOC42Mzg1NyA0LjgxMjUgOC4zNTI5OSA0LjgxMjUgOC4wMDA5OEM0LjgxMjUgNy42NDg5NiA1LjA5ODIgNy4zNjMzOSA1LjQ1MDIgNy4zNjMyOEgxMC41NDk4Wk01Ljg3NSA0LjYwMDU5QzYuMzQ0NDQgNC42MDA1OSA2LjcyNDYxIDQuOTgxNzMgNi43MjQ2MSA1LjQ1MTE3QzYuNzI0NSA1LjkyMDUyIDYuMzQ0MzggNi4zMDA3OCA1Ljg3NSA2LjMwMDc4QzUuNDA1NjIgNi4zMDA3OCA1LjAyNTUgNS45MjA1MiA1LjAyNTM5IDUuNDUxMTdDNS4wMjUzOSA0Ljk4MTczIDUuNDA1NTYgNC42MDA1OSA1Ljg3NSA0LjYwMDU5WiIgZmlsbD0iIzE4MUMyRiIgc3R5bGU9ImZpbGw6IzE4MUMyRjtmaWxsOmNvbG9yKGRpc3BsYXktcDMgMC4wOTQxIDAuMTA5OCAwLjE4NDMpO2ZpbGwtb3BhY2l0eToxOyIvPgo8L2c+Cjwvc3ZnPgo=";

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

      stream?.emit({
        type: "data-outline-update",
        data: {
          id: "workspace-summary",
          title: "Plan Summary",
          icon,
          timestamp: Date.now(),
          artifactId: artifactRefs?.[0]?.id,
          artifactLabel: "View Plan",
        },
      });

      return { artifactRefs };
    } catch (error) {
      logger.debug("summarizer tool failed", { error });

      return { artifactRefs: null };
    }
  },
});
