/**
 * Configuration management routes
 * Handles environment variable CRUD operations
 */

import { logger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";
import { getAtlasHome } from "@atlas/utils/paths.server";
import { parse, stringify } from "@std/dotenv";
import { exists } from "@std/fs";
import { join } from "@std/path";
import { describeRoute, resolver, validator } from "hono-openapi";
import { mkdir } from "node:fs/promises";
import z from "zod";
import { daemonFactory } from "../src/factory.ts";

// Schemas
const envVarsGetResponseSchema = z.object({
  success: z.boolean(),
  envVars: z.record(z.string(), z.string()).optional(),
  error: z.string().optional(),
});

const envVarsPutRequestSchema = z.object({ envVars: z.record(z.string(), z.string()) });

const envVarsPutResponseSchema = z.object({ success: z.boolean(), error: z.string().optional() });

const errorResponseSchema = z.object({ success: z.boolean(), error: z.string() });

// Routes
const configRoutes = daemonFactory.createApp();

configRoutes.get(
  "/env",
  describeRoute({
    tags: ["Config"],
    summary: "Get environment variables",
    description: "Read environment variables from ~/.atlas/.env file",
    responses: {
      200: {
        description: "Environment variables retrieved successfully",
        content: { "application/json": { schema: resolver(envVarsGetResponseSchema) } },
      },
      500: {
        description: "Internal server error",
        content: { "application/json": { schema: resolver(errorResponseSchema) } },
      },
    },
  }),
  async (c) => {
    try {
      const envPath = join(getAtlasHome(), ".env");

      if (!(await exists(envPath))) {
        logger.debug("No .env file found, returning empty env vars", { envPath });
        return c.json({ success: true, envVars: {} });
      }

      const content = await Deno.readTextFile(envPath);
      logger.debug("Reading environment variables from .env file", { envPath });
      const envVars = parse(content);

      logger.info("Environment variables retrieved", { count: Object.keys(envVars).length });
      return c.json({ success: true, envVars });
    } catch (error) {
      logger.error("Failed to read environment variables", { error: stringifyError(error) });
      return c.json({ success: false, error: stringifyError(error) }, 500);
    }
  },
);

configRoutes.put(
  "/env",
  describeRoute({
    tags: ["Config"],
    summary: "Update environment variables",
    description: "Write environment variables to ~/.atlas/.env file",
    responses: {
      200: {
        description: "Environment variables updated successfully",
        content: { "application/json": { schema: resolver(envVarsPutResponseSchema) } },
      },
      400: {
        description: "Bad request",
        content: { "application/json": { schema: resolver(errorResponseSchema) } },
      },
      500: {
        description: "Internal server error",
        content: { "application/json": { schema: resolver(errorResponseSchema) } },
      },
    },
  }),
  validator("json", envVarsPutRequestSchema),
  async (c) => {
    try {
      const { envVars } = c.req.valid("json");
      const atlasDir = getAtlasHome();
      const envPath = join(atlasDir, ".env");

      logger.debug("Writing environment variables to .env file", {
        envPath,
        count: Object.keys(envVars).length,
      });

      // Create .atlas directory if it doesn't exist
      if (!(await exists(atlasDir))) {
        await mkdir(atlasDir, { recursive: true });
      }

      // Write the file using @std/dotenv stringify
      const content = stringify(envVars);
      await Deno.writeTextFile(envPath, content);

      logger.info("Environment variables updated successfully", {
        envPath,
        count: Object.keys(envVars).length,
      });
      return c.json({ success: true });
    } catch (error) {
      logger.error("Failed to write environment variables", { error: stringifyError(error) });
      return c.json({ success: false, error: stringifyError(error) }, 500);
    }
  },
);

export { configRoutes };
export type ConfigRoutes = typeof configRoutes;
