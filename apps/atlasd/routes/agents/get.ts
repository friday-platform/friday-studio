import { AgentRegistry } from "@atlas/core";
import { describeRoute, resolver, validator } from "hono-openapi";
import { daemonFactory } from "../../src/factory.ts";
import { agentIdParamsSchema, agentMetadataSchema, errorResponseSchema } from "./schemas.ts";

const getAgent = daemonFactory.createApp();

getAgent.get(
  "/:id",
  describeRoute({
    tags: ["Agents"],
    summary: "Get agent details",
    description: "Returns detailed information about a specific agent",
    responses: {
      200: {
        description: "Successfully retrieved agent",
        content: { "application/json": { schema: resolver(agentMetadataSchema) } },
      },
      404: {
        description: "Agent not found",
        content: { "application/json": { schema: resolver(errorResponseSchema) } },
      },
      500: {
        description: "Internal server error",
        content: { "application/json": { schema: resolver(errorResponseSchema) } },
      },
    },
  }),
  validator("param", agentIdParamsSchema),
  async (c) => {
    try {
      const { id } = c.req.valid("param");

      const registry = new AgentRegistry();
      await registry.initialize();

      const agent = await registry.getAgent(id);
      if (!agent) {
        return c.json({ error: "Agent not found" }, 404);
      }

      return c.json(agent.metadata);
    } catch (error) {
      return c.json(
        { error: `Failed to get agent: ${error instanceof Error ? error.message : String(error)}` },
        500,
      );
    }
  },
);

export { getAgent };
