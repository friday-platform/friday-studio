import { logger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";
import { describeRoute, resolver } from "hono-openapi";
import { z } from "zod";
import { daemonFactory } from "../../src/factory.ts";
import { errorResponseSchema } from "../../src/utils.ts";
import { templateConfigSchema } from "./schemas.ts";

const listTemplates = daemonFactory.createApp();

/**
 * GET / - List available templates.
 *
 * Returns all available templates for content generation.
 */
listTemplates.get(
  "/",
  describeRoute({
    tags: ["Library"],
    summary: "List available templates",
    description: "Get all available templates for content generation.",
    responses: {
      200: {
        description: "Templates retrieved successfully",
        content: { "application/json": { schema: resolver(z.array(templateConfigSchema)) } },
      },
      500: {
        description: "Internal server error",
        content: { "application/json": { schema: resolver(errorResponseSchema) } },
      },
    },
  }),
  async (c) => {
    try {
      const app = c.get("app");
      const libraryStorage = app.getLibraryStorage();

      const templates = await libraryStorage.listTemplates();
      return c.json(templates);
    } catch (error) {
      logger.error("Failed to list templates", { error });
      return c.json({ error: `Failed to list templates: ${stringifyError(error)}` }, 500);
    }
  },
);

export { listTemplates };
