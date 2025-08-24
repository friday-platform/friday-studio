import { AgentRegistry } from "@atlas/core";
import { describeRoute, resolver, validator } from "hono-openapi";
import { daemonFactory } from "../../src/factory.ts";
import { agentExpertiseSchema, agentIdParamsSchema, errorResponseSchema } from "./schemas.ts";

const getAgentExpertise = daemonFactory.createApp();

getAgentExpertise.get(
  "/:id/expertise",
  describeRoute({
    tags: ["Agents"],
    summary: "Get agent expertise",
    description:
      "Returns expertise information for a specific agent including domains, capabilities, and example prompts",
    responses: {
      200: {
        description: "Successfully retrieved agent expertise",
        content: { "application/json": { schema: resolver(agentExpertiseSchema) } },
      },
      404: {
        description: "Agent expertise not found",
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
      if (!agent || !agent.metadata.expertise) {
        return c.json({ error: "Agent expertise not found" }, 404);
      }

      const response = { agentId: id, ...agent.metadata.expertise };

      return c.json(response);
    } catch (error) {
      return c.json(
        {
          error: `Failed to get agent expertise: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
        500,
      );
    }
  },
);

export { getAgentExpertise };
