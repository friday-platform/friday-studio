import { stringifyError } from "@atlas/utils";
import { describeRoute, resolver, validator } from "hono-openapi";
import { z } from "zod";
import { daemonFactory } from "../../src/factory.ts";
import { agentIdParamsSchema, agentMetadataSchema, errorResponseSchema } from "./schemas.ts";

/**
 * Type guard for Zod schema objects — checks for Zod v4's internal `_zod` brand.
 */
function isZodSchema(value: unknown): value is z.ZodType {
  return value != null && typeof value === "object" && "_zod" in value;
}

/**
 * Convert a Zod schema to JSON Schema for serialization.
 * Returns the value as-is if already serializable, undefined if conversion fails.
 */
function serializeSchema(schema: unknown): unknown {
  if (schema == null) return undefined;
  if (isZodSchema(schema)) {
    try {
      return z.toJSONSchema(schema);
    } catch {
      return undefined;
    }
  }
  return schema;
}

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

      const registry = c.get("app").getAgentRegistry();
      const agent = await registry.getAgent(id);
      if (!agent) {
        return c.json({ error: "Agent not found" }, 404);
      }

      const { metadata } = agent;
      return c.json({
        ...metadata,
        inputSchema: serializeSchema(metadata.inputSchema),
        outputSchema: serializeSchema(metadata.outputSchema),
      });
    } catch (error) {
      return c.json({ error: `Failed to get agent: ${stringifyError(error)}` }, 500);
    }
  },
);

export { getAgent };
