import { randomUUID } from "node:crypto";
import type { ArtifactRef, OutlineRef } from "@atlas/agent-sdk";
import { createAgent, err, ok } from "@atlas/agent-sdk";
import { registry, temporalGroundingMessage, traceModel } from "@atlas/llm";
import { stringifyError } from "@atlas/utils";
import { generateText, stepCountIs } from "ai";
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
    "both search and browser interaction.",
  constraints:
    "Requires `agent-browser` CLI for browser interaction and Parallel API access " +
    "(`PARALLEL_API_KEY` or `FRIDAY_GATEWAY_URL`+`ATLAS_KEY`) for search. " +
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
  handler: async (prompt, { session, logger, stream, config, abortSignal }) => {
    logger.info("Starting web agent", { prompt: prompt.slice(0, 200) });

    const artifactRefs: ArtifactRef[] = [];
    const outlineRefs: OutlineRef[] = [];
    const sessionState: SessionState = {
      sessionName: `atlas-web-${randomUUID()}`,
      daemonStarted: false,
    };

    try {
      const result = await generateText({
        model: traceModel(registry.languageModel("google:gemini-3.1-pro-preview")),
        messages: [
          { role: "system", content: getWebAgentPrompt() },
          temporalGroundingMessage(),
          { role: "user", content: prompt },
        ],
        tools: {
          search: createSearchTool(
            { session, stream, logger, config, abortSignal },
            { artifactRefs, outlineRefs },
          ),
          fetch: createFetchTool(),
          browse: createBrowseTool(stream, sessionState, abortSignal),
        },
        stopWhen: stepCountIs(300),
        maxRetries: 3,
        abortSignal,
      });

      logger.debug("Web agent complete", { usage: result.usage, steps: result.steps?.length ?? 0 });

      const response = result.text || "Web task completed but no summary generated.";

      return ok({ response }, { artifactRefs, outlineRefs });
    } catch (error) {
      logger.error("Web agent failed", { error });
      return err(stringifyError(error));
    } finally {
      await stopSession(sessionState);
    }
  },
});
