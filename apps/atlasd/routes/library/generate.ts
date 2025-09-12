import { logger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";
import { describeRoute, resolver } from "hono-openapi";
import { daemonFactory } from "../../src/factory.ts";
import { errorResponseSchema } from "../../src/utils.ts";
import { generateFromTemplateSchema, generateTemplateResponseSchema } from "./schemas.ts";

const generateFromTemplate = daemonFactory.createApp();

/**
 * POST / - Generate content from template.
 *
 * Uses a template to generate content with provided data.
 * Note: Template generation is not yet implemented.
 */
generateFromTemplate.post(
  "/",
  describeRoute({
    tags: ["Library"],
    summary: "Generate content from template",
    description: "Generate content using a template with provided data and options.",
    requestBody: {
      required: true,
      content: { "application/json": { schema: resolver(generateFromTemplateSchema) } },
    },
    responses: {
      200: {
        description: "Content generated successfully",
        content: { "application/json": { schema: resolver(generateTemplateResponseSchema) } },
      },
      400: {
        description: "Invalid request",
        content: { "application/json": { schema: resolver(errorResponseSchema) } },
      },
      501: {
        description: "Not implemented",
        content: { "application/json": { schema: resolver(generateTemplateResponseSchema) } },
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

      const { templateId, data, options } = await c.req.json();

      if (!templateId) {
        return c.json({ error: "templateId is required" }, 400);
      }

      // This would need template engine integration
      // For now, return a simple response
      return c.json(
        { message: "Template generation not yet implemented", templateId, data, options },
        501,
      );
    } catch (error) {
      logger.error("Failed to generate from template", { error });
      return c.json({ error: `Failed to generate from template: ${stringifyError(error)}` }, 500);
    }
  },
);

export { generateFromTemplate };
