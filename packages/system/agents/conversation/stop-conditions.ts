import type { AtlasTools } from "@atlas/agent-sdk";
import type { StopCondition } from "ai";
import z from "zod";
import { FSMCreatorResultSchema } from "../../agent-types/mod.ts";

const mcpAgentResult = z.object({
  result: z.object({ content: z.object({ type: z.literal("text"), text: z.string() }).array() }),
});

export const workspaceCreationComplete =
  (): StopCondition<AtlasTools> =>
  ({ steps }) => {
    for (const step of steps) {
      for (const toolResult of step.toolResults) {
        if (toolResult.toolName !== "fsm-workspace-creator") {
          continue;
        }
        try {
          const mcpResult = mcpAgentResult.parse(toolResult.output);
          const agentResultString = mcpResult.result.content.at(0)?.text;
          if (!agentResultString) {
            throw new Error("No content in MCP result");
          }
          const agentResult = z
            .object({ type: z.literal("completed"), result: FSMCreatorResultSchema })
            .parse(JSON.parse(agentResultString));
          if (agentResult.result.ok) {
            return true;
          }
        } catch (e) {
          console.error(e);
          return false;
        }
      }
    }
    return false;
  };
