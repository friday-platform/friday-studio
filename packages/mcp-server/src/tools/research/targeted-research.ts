import { targetedResearchAgent } from "@atlas/bundled-agents";
import { createLogger } from "@atlas/logger";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createSuccessResponse, type ToolContext } from "../types.ts";

export function registerTargetedResearchTool(server: McpServer, _ctx: ToolContext) {
  server.registerTool(
    "targeted_research",
    {
      description:
        "Run targeted web research: executes multi-query search with optional domain focus, extracts page content, and returns a cited synthesis.",
      inputSchema: {
        prompt: z
          .string()
          .min(1)
          .describe(
            "Research request in natural language. Example: 'Summarize recent r/webdev posts about React Server Components'",
          ),
      },
    },
    async ({ prompt }) => {
      // Minimal stream emitter; events are not forwarded from this tool today
      const stream = {
        emit: (_event: unknown) => undefined,
        end: () => undefined,
        error: (_error: Error) => undefined,
      };

      const session = { sessionId: crypto.randomUUID(), workspaceId: "global" };
      const agentLogger = createLogger({ component: "platform.targeted-research" });

      const result = await targetedResearchAgent.execute(prompt, {
        tools: {},
        session,
        env: {},
        stream,
        logger: agentLogger,
      });

      return createSuccessResponse(result);
    },
  );
}
