import { randomUUID } from "node:crypto";
import process from "node:process";
import { createAgent, err, ok } from "@atlas/agent-sdk";
import { streamTextWithEvents } from "@atlas/agent-sdk/vercel-helpers";
import { registry, temporalGroundingMessage, traceModel } from "@atlas/llm";
import { stringifyError } from "@atlas/utils";
import { stepCountIs } from "ai";
import { z } from "zod";

import { getWebAgentPrompt } from "./prompts.ts";
import { createBrowseTool, type SessionState, stopSession } from "./tools/browse.ts";
import { createFetchTool } from "./tools/fetch.ts";
import { createSearchTool } from "./tools/search.ts";

const WebOutputSchema = z.object({
  response: z.string().describe("Summary of what was found or accomplished"),
});

export type WebAgentResult = z.infer<typeof WebOutputSchema>;
export { WebOutputSchema };

export const webAgent = createAgent<string, WebAgentResult>({
  id: "web",
  displayName: "Web",
  version: "1.0.0",
  description:
    "Search the web, read pages, and interact with websites in a real browser. " +
    "Combines multi-query research (with sourced report artifacts), URL reading, and " +
    "browser automation (login, forms, clicks, JS-rendered content). USE FOR: web " +
    "research, finding current information, reading JS-rendered pages, logging into " +
    "sites, filling forms, completing multi-step web workflows, any task requiring " +
    "both search and browser interaction. " +
    "For tasks involving a specific service that has a workspace MCP server configured " +
    "(e.g. `google-gmail`, `google-calendar`), use `delegate` with `mcpServers` instead of this agent.",
  constraints:
    "Requires `agent-browser` CLI for browser interaction. " +
    "Web search is available when a search provider key is configured " +
    "(`PARALLEL_API_KEY` or `FRIDAY_GATEWAY_URL`+`FRIDAY_KEY`); without one " +
    "the agent can still fetch URLs and browse but cannot search. " +
    "Set `AGENT_BROWSER_AUTO_CONNECT=1` to attach to your already-running Chrome " +
    "(note: in this mode all concurrent invocations share that browser — isolation " +
    "is not guaranteed). Otherwise an isolated Chrome is spawned per invocation. " +
    "Cannot bypass CAPTCHAs. For simple static URL reads, built-in webfetch suffices " +
    "— use this agent when you need search synthesis, page interaction, or " +
    "JS-rendered content.",
  outputSchema: WebOutputSchema,
  expertise: {
    examples: [
      "Research the latest developments in quantum computing and summarize key breakthroughs",
      "Read the content at https://example.com/docs and extract the API reference",
      "Extract the top 5 headlines from Hacker News",
      "Find the best-rated restaurant in SF and make a reservation",
    ],
  },
  handler: async (prompt, { session, logger, stream, config, abortSignal, platformModels }) => {
    logger.info(`[web] start: ${prompt.slice(0, 120).replace(/\s+/g, " ")}`);

    const sessionState: SessionState = {
      sessionName: `atlas-web-${randomUUID()}`,
      daemonStarted: false,
    };

    try {
      const hasSearchKey = Boolean(process.env.PARALLEL_API_KEY || process.env.FRIDAY_GATEWAY_URL);

      const searchTool = hasSearchKey
        ? createSearchTool({ session, stream, logger, config, abortSignal, platformModels })
        : null;

      if (!hasSearchKey) {
        logger.info("[web] search tool disabled — no PARALLEL_API_KEY or FRIDAY_GATEWAY_URL");
      }

      const tools = {
        fetch: createFetchTool(logger),
        browse: createBrowseTool(stream, sessionState, abortSignal, logger),
        ...(searchTool ? { search: searchTool } : {}),
      };

      const result = await streamTextWithEvents({
        params: {
          model: traceModel(registry.languageModel("anthropic:claude-sonnet-4-6")),
          messages: [
            { role: "system", content: getWebAgentPrompt({ hasSearch: hasSearchKey }) },
            temporalGroundingMessage(),
            { role: "user", content: prompt },
          ],
          tools,
          stopWhen: stepCountIs(300),
          maxRetries: 3,
          abortSignal,
          providerOptions: { anthropic: { thinking: { type: "enabled", budgetTokens: 4000 } } },
        },
        stream,
      });

      const steps = result.steps?.length ?? 0;
      const responseLen = result.text?.length ?? 0;
      logger.info(`[web] done: ${steps} steps, ${responseLen} chars response`);

      const response = result.text || "Web task completed but no summary generated.";

      return ok(
        { response },
        {
          reasoning: result.reasoning,
          toolCalls: result.toolCalls,
          toolResults: result.toolResults,
        },
      );
    } catch (error) {
      logger.error(`[web] failed: ${stringifyError(error).slice(0, 200)}`);
      return err(stringifyError(error));
    } finally {
      await stopSession(sessionState);
    }
  },
});
