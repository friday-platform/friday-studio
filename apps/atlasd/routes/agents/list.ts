import { daemonFactory } from "../../src/factory.ts";
import { describeRoute, resolver } from "hono-openapi";
import { agentListResponseSchema, errorResponseSchema } from "./schemas.ts";
import { AgentRegistry } from "@atlas/core";

const listAgents = daemonFactory.createApp();

listAgents.get(
  "/",
  describeRoute({
    tags: ["Agents"],
    summary: "List all available agents",
    description:
      "Returns a list of all agents available in the system, including their metadata and expertise information",
    responses: {
      200: {
        description: "Successfully retrieved agents",
        content: {
          "application/json": {
            schema: resolver(agentListResponseSchema),
          },
        },
      },
      500: {
        description: "Internal server error",
        content: {
          "application/json": {
            schema: resolver(errorResponseSchema),
          },
        },
      },
    },
  }),
  async (c) => {
    try {
      // Get registry instance
      const registry = new AgentRegistry();
      await registry.initialize();

      // List all agents
      const agents = await registry.listAgents();

      const response = {
        agents,
        total: agents.length,
      };

      return c.json(response);
    } catch (error) {
      return c.json(
        {
          error: `Failed to list agents: ${error instanceof Error ? error.message : String(error)}`,
        },
        500,
      );
    }
  },
);

export { listAgents };
