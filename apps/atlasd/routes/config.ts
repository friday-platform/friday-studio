/**
 * Configuration management routes
 * Handles environment variable CRUD operations
 */

import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { createPlatformModels, PlatformModelsConfigError } from "@atlas/llm";
import { logger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";
import { getAtlasHome } from "@atlas/utils/paths.server";
import { parse, stringify } from "@std/dotenv";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import { describeRoute, resolver, validator } from "hono-openapi";
import z from "zod";

/**
 * Check if a file or directory exists at the given path.
 */
async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

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

      const content = await readFile(envPath, "utf-8");
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
      await writeFile(envPath, content, "utf-8");

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

// ---------------------------------------------------------------------------
// Models (friday.yml → PlatformModels)
// ---------------------------------------------------------------------------
// Surfaces the four per-role models (labels, classifier, planner,
// conversational) the daemon resolved at startup. Read-only — editing
// requires mutating friday.yml and restarting, which is out of scope for
// the MVP settings page (plan item 4.3 in
// docs/plans/2026-04-16-chat-ux-and-fast-improvements.md).

const PLATFORM_ROLES = ["labels", "classifier", "planner", "conversational"] as const;
type ModelRole = (typeof PLATFORM_ROLES)[number];

const modelInfoSchema = z.object({
  role: z.enum(PLATFORM_ROLES),
  /** What the daemon resolved at startup (from friday.yml OR default chain). */
  resolved: z.object({ provider: z.string(), modelId: z.string() }),
  /** Raw `provider:model` string from friday.yml if set, else null (using default). */
  configured: z.string().nullable(),
});
const modelsGetResponseSchema = z.object({
  success: z.boolean(),
  models: z.array(modelInfoSchema).optional(),
  configPath: z.string().optional(),
  error: z.string().optional(),
});

const modelsPutRequestSchema = z.object({
  /** Per-role `provider:model` strings. Empty string or null clears the entry (reverts to default). */
  models: z.object({
    labels: z.string().nullable().optional(),
    classifier: z.string().nullable().optional(),
    planner: z.string().nullable().optional(),
    conversational: z.string().nullable().optional(),
  }),
});
const modelsPutResponseSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
  /** Set to true when the server-side restart hook is available. */
  restartRequired: z.boolean().optional(),
});

/**
 * Resolve the friday.yml path the same way daemon startup does
 * (see `atlas-daemon.ts:260`). Keeps read and write consistent.
 */
function getFridayYmlPath(): string {
  const configDir = process.env.ATLAS_CONFIG_PATH ?? process.cwd();
  return join(configDir, "friday.yml");
}

async function readFridayConfig(): Promise<Record<string, unknown>> {
  const path = getFridayYmlPath();
  if (!(await exists(path))) return {};
  const raw = await readFile(path, "utf-8");
  const parsed = parseYaml(raw);
  if (typeof parsed !== "object" || parsed === null) return {};
  return parsed as Record<string, unknown>;
}

configRoutes.get(
  "/models",
  describeRoute({
    tags: ["Config"],
    summary: "Get platform models (resolved + configured)",
    description:
      "Returns per-role models. `resolved` is what the daemon is using right now. `configured` is what `friday.yml` pins (null means 'using default chain').",
    responses: {
      200: {
        description: "Platform models retrieved",
        content: { "application/json": { schema: resolver(modelsGetResponseSchema) } },
      },
    },
  }),
  async (c) => {
    const ctx = c.get("app");
    const configPath = getFridayYmlPath();

    let configuredModels: Record<string, unknown> = {};
    try {
      const friday = await readFridayConfig();
      const rawModels = friday.models;
      if (typeof rawModels === "object" && rawModels !== null) {
        configuredModels = rawModels as Record<string, unknown>;
      }
    } catch (error) {
      logger.warn("friday.yml read failed during models GET", { error: stringifyError(error) });
    }

    const models = PLATFORM_ROLES.map((role: ModelRole) => {
      const m = ctx.platformModels.get(role);
      const configured = configuredModels[role];
      return {
        role,
        resolved: { provider: m.provider, modelId: m.modelId },
        configured: typeof configured === "string" && configured.length > 0 ? configured : null,
      };
    });

    return c.json({ success: true, models, configPath });
  },
);

configRoutes.put(
  "/models",
  describeRoute({
    tags: ["Config"],
    summary: "Update platform models in friday.yml",
    description:
      "Writes the `models.*` section of `friday.yml`. Validates each entry via `createPlatformModels` before writing, so bad provider/model IDs (or missing credentials) fail fast with a descriptive message. Changes take effect on next daemon restart.",
    responses: {
      200: {
        description: "friday.yml updated",
        content: { "application/json": { schema: resolver(modelsPutResponseSchema) } },
      },
      400: {
        description: "Validation failed (bad provider/model or missing credential)",
        content: { "application/json": { schema: resolver(modelsPutResponseSchema) } },
      },
    },
  }),
  validator("json", modelsPutRequestSchema),
  async (c) => {
    const { models: incoming } = c.req.valid("json");

    // Build the new `models` map, skipping empty/null entries (they mean
    // "use the default chain" which maps to "omit the key").
    const newModels: Partial<Record<ModelRole, string>> = {};
    for (const role of PLATFORM_ROLES) {
      const value = incoming[role];
      if (typeof value === "string" && value.trim().length > 0) {
        newModels[role] = value.trim();
      }
    }

    // Pre-flight validation: run the same resolver the daemon uses at boot
    // so bad values don't get written. `PlatformModelsConfigError` already
    // aggregates per-role problems with actionable messages.
    try {
      createPlatformModels({ models: newModels });
    } catch (error) {
      if (error instanceof PlatformModelsConfigError) {
        return c.json({ success: false, error: error.message }, 400);
      }
      logger.error("Unexpected error validating models", { error: stringifyError(error) });
      return c.json({ success: false, error: stringifyError(error) }, 400);
    }

    try {
      const path = getFridayYmlPath();
      const current = await readFridayConfig();
      const next: Record<string, unknown> = { ...current };

      // AtlasConfigSchema requires `version: "1.0"` and a `workspace` block
      // (it extends WorkspaceConfigSchema, so daemon startup refuses a file
      // with only `models:`). Supply defaults when the file didn't exist or
      // was otherwise missing these.
      if (!("version" in next)) next.version = "1.0";
      if (!("workspace" in next) || typeof next.workspace !== "object" || next.workspace === null) {
        next.workspace = { name: "atlas-platform" };
      }

      if (Object.keys(newModels).length === 0) {
        delete next.models;
      } else {
        next.models = newModels;
      }

      // YAML key order follows object insertion order — put the load-order-
      // significant keys first, then everything else, so the file diff is
      // readable and matches docs/COMPREHENSIVE_FRIDAY_EXAMPLE.yml.
      const ordered: Record<string, unknown> = {};
      ordered.version = next.version;
      ordered.workspace = next.workspace;
      if ("models" in next) ordered.models = next.models;
      for (const [k, v] of Object.entries(next)) {
        if (k !== "version" && k !== "workspace" && k !== "models") ordered[k] = v;
      }

      await writeFile(path, stringifyYaml(ordered), "utf-8");
      logger.info("Wrote friday.yml models section", { path, roles: Object.keys(newModels) });
      return c.json({ success: true, restartRequired: true });
    } catch (error) {
      logger.error("Failed to write friday.yml", { error: stringifyError(error) });
      return c.json({ success: false, error: stringifyError(error) }, 500);
    }
  },
);

export { configRoutes };
export type ConfigRoutes = typeof configRoutes;
