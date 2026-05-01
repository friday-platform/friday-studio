import { stringifyError } from "@atlas/utils";
import { describeRoute, resolver, validator } from "hono-openapi";
import { z } from "zod";
import { daemonFactory } from "../../src/factory.ts";
import { agentListResponseSchema, errorResponseSchema } from "./schemas.ts";

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
        content: { "application/json": { schema: resolver(agentListResponseSchema) } },
      },
      500: {
        description: "Internal server error",
        content: { "application/json": { schema: resolver(errorResponseSchema) } },
      },
    },
  }),
  validator(
    "query",
    z.object({ limit: z.coerce.number().int().min(1).max(500).optional().default(100) }),
  ),
  async (c) => {
    try {
      const { limit } = c.req.valid("query");
      const registry = c.get("app").getAgentRegistry();
      const agents = await registry.listAgents();

      const limited = agents.slice(0, limit);
      return c.json({ agents: limited, total: agents.length });
    } catch (error) {
      return c.json({ error: `Failed to list agents: ${stringifyError(error)}` }, 500);
    }
  },
);

export { listAgents };
