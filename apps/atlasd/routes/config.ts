/**
 * Configuration management routes
 * Handles environment variable CRUD operations
 */

import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import {
  createPlatformModels,
  DEFAULT_PLATFORM_MODELS,
  getCatalog,
  invalidateCatalog,
  type PlatformModels,
  PlatformModelsConfigError,
  resetRegistry,
} from "@atlas/llm";
import { logger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";
import { getFridayHome } from "@atlas/utils/paths.server";
import { loadEnvFile } from "@atlas/workspace";
import { parse } from "@std/dotenv";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import { describeRoute, resolver, validator } from "hono-openapi";
import z from "zod";
import { devOnlyMiddleware } from "../src/dev-only.ts";
import {
  commitGlobalEnvDelete,
  commitGlobalEnvWrite,
  HOT_RELOAD_DENYLIST,
} from "../src/env-commit.ts";

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

/**
 * Serialize env vars into `.env` format without unnecessary quoting.
 *
 * @std/dotenv's stringify wraps any value containing a non-word char
 * (a `-` in an API key, a `/` in a URL, …) in single quotes. The
 * launcher's loadDotEnv (tools/friday-launcher/project.go) reads the
 * file as-is and forwards `KEY='sk-ant-foo'` verbatim to spawned
 * services, so agents inherit the literal quotes and the API key
 * fails to authenticate. The Tauri installer's render_env_lines also
 * writes unquoted, so this matches the format the rest of the stack
 * already expects.
 *
 * Inputs are pre-validated by envVarsPutRequestSchema: keys are POSIX
 * identifiers and values contain no CR/LF, so we don't need to handle
 * multi-line escapes here (the Go launcher's unquoteEnvValue strips
 * outer quotes only — it would forward `\n` literally).
 *
 * Quoting rules picked to round-trip through @std/dotenv's parse:
 *   - whitespace, `#`, `$`, leading `'`/`"`, or backslash
 *                  → single-quote (literal, no expansion)
 *   - value containing `'`
 *                  → double-quote with `\` and `"` escapes
 *   - otherwise    → unquoted
 */
function stringifyEnv(envVars: Record<string, string>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(envVars)) {
    if (key.startsWith("#")) continue;
    const v = value ?? "";

    const needsQuoting = /[\s#$"'\\]/.test(v) || /^['"]/.test(v);

    if (!needsQuoting) {
      lines.push(`${key}=${v}`);
      continue;
    }

    if (!v.includes("'")) {
      lines.push(`${key}='${v}'`);
      continue;
    }

    const escaped = v.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    lines.push(`${key}="${escaped}"`);
  }
  return lines.join("\n");
}

import { daemonFactory } from "../src/factory.ts";

// Schemas
const envVarsGetResponseSchema = z.object({
  success: z.boolean(),
  envVars: z.record(z.string(), z.string()).optional(),
  /**
   * Absolute path of the .env file the daemon read. Surfaced so UI labels
   * can show the same path the daemon actually operates on — under the
   * Friday Studio launcher this is `~/.friday/local/.env`; under manual
   * `atlas daemon start` it falls back to `~/.atlas/.env`.
   */
  envPath: z.string().optional(),
  error: z.string().optional(),
});

/**
 * Keys: POSIX env-var identifiers — `[A-Za-z_][A-Za-z0-9_]*`. Tighter than
 * what @std/dotenv parse accepts on the read side, deliberately: a key
 * containing `\n` would let one PUT entry split into two on-disk lines and
 * smuggle additional env vars into spawned services on the next launcher
 * import.
 *
 * Values: no CR/LF. The Settings UI never sends multi-line values today,
 * and the Go launcher's unquoteEnvValue strips outer quotes only — it
 * doesn't expand `\n` escapes — so any multi-line value would reach
 * spawned services with literal backslash-n. Reject at the boundary.
 */
const envVarsPutRequestSchema = z.object({
  envVars: z.record(
    z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "env var keys must be POSIX identifiers"),
    z.string().regex(/^[^\r\n]*$/, "env var values must not contain newlines"),
  ),
});

/**
 * Re-exported from `env-commit.ts` (the owner). Kept exported here because
 * `config.test.ts` imports it from this module and the bulk `PUT /env`
 * handler below references it inline.
 */
export { HOT_RELOAD_DENYLIST };

const envVarsPutResponseSchema = z.object({ success: z.boolean(), error: z.string().optional() });

const errorResponseSchema = z.object({ success: z.boolean(), error: z.string() });

/** Per-key path param — POSIX identifier, same constraint as the bulk PUT. */
const envKeyParamSchema = z.object({
  key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "env var keys must be POSIX identifiers"),
});

/** Per-key value body — single-line, same constraint as the bulk PUT. */
const envValueBodySchema = z.object({
  value: z.string().regex(/^[^\r\n]*$/, "env var values must not contain newlines"),
});

// Routes
const configRoutes = daemonFactory.createApp();

// Reading + writing the daemon's `.env` is an operator-level surface
// (API keys, credentials, port overrides). In multi-user / cloud
// deployments any logged-in caller hitting these routes is a tenant
// isolation hole — gate them to dev mode until an instance-admin
// role lands. Studio + the CLI set `FRIDAY_ENV=dev` automatically so
// local-first usage is unaffected.
configRoutes.use("/env", devOnlyMiddleware());
configRoutes.use("/env/*", devOnlyMiddleware());

configRoutes.get(
  "/env",
  describeRoute({
    tags: ["Config"],
    summary: "Get environment variables",
    description:
      "Read environment variables from <friday-home>/.env. The home is " +
      "resolved via getFridayHome() — `~/.friday/local` when FRIDAY_HOME " +
      "is set by the Studio launcher, `~/.atlas` otherwise.",
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
      const envPath = join(getFridayHome(), ".env");

      if (!(await exists(envPath))) {
        logger.debug("No .env file found, returning empty env vars", { envPath });
        return c.json({ success: true, envVars: {}, envPath });
      }

      const content = await readFile(envPath, "utf-8");
      logger.debug("Reading environment variables from .env file", { envPath });
      const envVars = parse(content);

      logger.info("Environment variables retrieved", { count: Object.keys(envVars).length });
      return c.json({ success: true, envVars, envPath });
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
    description:
      "Write environment variables to <friday-home>/.env. The home is " +
      "resolved via getFridayHome() — `~/.friday/local` when FRIDAY_HOME " +
      "is set by the Studio launcher, `~/.atlas` otherwise.",
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
      const atlasDir = getFridayHome();
      const envPath = join(atlasDir, ".env");

      logger.debug("Writing environment variables to .env file", {
        envPath,
        count: Object.keys(envVars).length,
      });

      // Prior on-disk keys feed the delete-set for the in-memory sync.
      // Shell-inherited env (`export FOO=…` before daemon launch) is
      // never in this set, so the user "removing" such a key in the UI
      // leaves the shell value sticky in `process.env`.
      let priorKeys: Set<string> = new Set();
      if (await exists(envPath)) {
        try {
          priorKeys = new Set(Object.keys(parse(await readFile(envPath, "utf-8"))));
        } catch (error) {
          logger.warn("Could not parse prior .env for in-memory sync; deletes will be skipped", {
            envPath,
            error: stringifyError(error),
          });
        }
      }

      // Create .atlas directory if it doesn't exist
      if (!(await exists(atlasDir))) {
        await mkdir(atlasDir, { recursive: true });
      }

      const content = stringifyEnv(envVars);
      await writeFile(envPath, content, "utf-8");

      // Deno's `--env-file` reads once at startup, and the catalog +
      // provider registry memoize `process.env` reads, so mirror the
      // file write into the running process and bust both caches.
      // Subprocess agents already running keep their spawn-time env.
      try {
        for (const k of priorKeys) {
          if (HOT_RELOAD_DENYLIST.has(k)) continue;
          if (!(k in envVars)) delete process.env[k];
        }
        for (const [k, v] of Object.entries(envVars)) {
          if (HOT_RELOAD_DENYLIST.has(k)) {
            logger.warn("Skipping in-memory sync for denylisted key (written to .env only)", {
              key: k,
            });
            continue;
          }
          process.env[k] = v;
        }
        resetRegistry();
        invalidateCatalog();
      } catch (error) {
        // File write already succeeded; restart fallback still works.
        logger.warn("In-memory env sync failed after .env write", { error: stringifyError(error) });
      }

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
// Per-key env routes — single-key CRUD over <friday-home>/.env.
//
// Comment-preserving (line-based editor), unlike the bulk PUT above which
// re-stringifies the whole file. The agent-facing env tools route through
// here so a single set/delete never eats comments or unrelated keys.
// ---------------------------------------------------------------------------

const envKeyResponseSchema = z.object({
  success: z.boolean(),
  key: z.string().optional(),
  value: z.string().optional(),
  removed: z.boolean().optional(),
  error: z.string().optional(),
});

configRoutes.get(
  "/env/:key",
  describeRoute({
    tags: ["Config"],
    summary: "Get one environment variable from <friday-home>/.env",
    responses: {
      200: {
        description: "Value retrieved",
        content: { "application/json": { schema: resolver(envKeyResponseSchema) } },
      },
      404: {
        description: "Key not set",
        content: { "application/json": { schema: resolver(envKeyResponseSchema) } },
      },
    },
  }),
  validator("param", envKeyParamSchema),
  (c) => {
    const { key } = c.req.valid("param");
    const envPath = join(getFridayHome(), ".env");
    const value = loadEnvFile(envPath)[key];
    if (value === undefined) {
      return c.json({ success: false, error: `'${key}' is not set` }, 404);
    }
    return c.json({ success: true, key, value });
  },
);

configRoutes.put(
  "/env/:key",
  describeRoute({
    tags: ["Config"],
    summary: "Set one environment variable in <friday-home>/.env",
    description:
      "Comment-preserving single-key write. Mirrors the change into the running " +
      "daemon's process.env (except hot-reload-denylisted keys) and busts the " +
      "model/provider caches.",
    responses: {
      200: {
        description: "Value set",
        content: { "application/json": { schema: resolver(envKeyResponseSchema) } },
      },
      500: {
        description: "Internal error",
        content: { "application/json": { schema: resolver(errorResponseSchema) } },
      },
    },
  }),
  validator("param", envKeyParamSchema),
  validator("json", envValueBodySchema),
  (c) => {
    const { key } = c.req.valid("param");
    const { value } = c.req.valid("json");
    try {
      commitGlobalEnvWrite(key, value);
      logger.info("Global env var set", { key });
      return c.json({ success: true, key });
    } catch (error) {
      logger.error("Failed to set global env var", { key, error: stringifyError(error) });
      return c.json({ success: false, error: stringifyError(error) }, 500);
    }
  },
);

configRoutes.delete(
  "/env/:key",
  describeRoute({
    tags: ["Config"],
    summary: "Delete one environment variable from <friday-home>/.env",
    responses: {
      200: {
        description: "Delete attempted",
        content: { "application/json": { schema: resolver(envKeyResponseSchema) } },
      },
      500: {
        description: "Internal error",
        content: { "application/json": { schema: resolver(errorResponseSchema) } },
      },
    },
  }),
  validator("param", envKeyParamSchema),
  (c) => {
    const { key } = c.req.valid("param");
    try {
      const removed = commitGlobalEnvDelete(key);
      logger.info("Global env var delete", { key, removed });
      return c.json({ success: true, key, removed });
    } catch (error) {
      logger.error("Failed to delete global env var", { key, error: stringifyError(error) });
      return c.json({ success: false, error: stringifyError(error) }, 500);
    }
  },
);

// ---------------------------------------------------------------------------
// Models (friday.yml → PlatformModels)
// ---------------------------------------------------------------------------
// Surfaces the five per-role models (labels, classifier, planner,
// conversational, image) the daemon resolved at startup. Read-only —
// editing requires mutating friday.yml and restarting.

const PLATFORM_ROLES = ["labels", "classifier", "planner", "conversational", "image"] as const;
type ModelRole = (typeof PLATFORM_ROLES)[number];

const modelInfoSchema = z.object({
  role: z.enum(PLATFORM_ROLES),
  /** What the daemon resolved at startup (from friday.yml OR default chain). */
  resolved: z.object({ provider: z.string(), modelId: z.string() }),
  /**
   * The raw value from friday.yml:
   * - `null` → role unset (using default chain).
   * - `string` → single model id ("primary only", back-compat shape).
   * - `string[]` → explicit primary → fallback chain, rendered as is in
   *   the UI's draggable slots.
   */
  configured: z.union([z.string(), z.array(z.string()), z.null()]),
});
const modelsGetResponseSchema = z.object({
  success: z.boolean(),
  models: z.array(modelInfoSchema).optional(),
  configPath: z.string().optional(),
  error: z.string().optional(),
});

/**
 * A single role's configured value on the way into friday.yml. Same three
 * shapes the daemon accepts — a bare string for back-compat / primary-only
 * setups, an array for chains, `null` to clear.
 */
const roleValueSchema = z.union([z.string(), z.array(z.string()), z.null()]);

const modelsPutRequestSchema = z.object({
  /**
   * Per-role configuration. `string` for a single model (back-compat),
   * `string[]` for a primary→fallback chain, `null`/empty to clear the
   * entry and revert to the default chain.
   */
  models: z.object({
    labels: roleValueSchema.optional(),
    classifier: roleValueSchema.optional(),
    planner: roleValueSchema.optional(),
    conversational: roleValueSchema.optional(),
    image: roleValueSchema.optional(),
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
  const configDir = process.env.FRIDAY_CONFIG_PATH ?? process.cwd();
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

type ResolvedModel = { provider: string; modelId: string };

function pickLanguageResolved(
  platformModels: PlatformModels,
  role: Exclude<ModelRole, "image">,
): ResolvedModel {
  const m = platformModels.get(role);
  return { provider: m.provider, modelId: m.modelId };
}

/**
 * Resolve the image-role "resolved" tile value for the Settings GET response.
 *
 * Image resolution diverges from the language roles in two ways:
 *   1. The resolver method is `getImage()` (returns `ImageModelV3`,
 *      not `LanguageModelV3`).
 *   2. `getImage()` defers credential checks to call time, so it CAN
 *      throw post-boot when no chain entry is credentialed. Boot only
 *      validates format and overlay membership for the image role.
 *
 * Strategy: try `getImage()` first; on success, return its resolved
 * provider+modelId. On failure, fall back to the user's configured chain
 * head if they set one, otherwise `DEFAULT_PLATFORM_MODELS.image[0]`.
 * This lets the UI tile render what the user *meant* even when the
 * credential isn't available yet — the locked-banner UX then carries
 * the credential-missing signal to the user.
 */
function resolveImageRoleForGet(
  platformModels: PlatformModels,
  configured: string | string[] | null,
): ResolvedModel {
  try {
    const m = platformModels.getImage();
    return { provider: m.provider, modelId: m.modelId };
  } catch {
    const head =
      typeof configured === "string"
        ? configured
        : Array.isArray(configured) && configured.length > 0
          ? configured[0]
          : DEFAULT_PLATFORM_MODELS.image[0];
    return parseProviderModelId(head ?? DEFAULT_PLATFORM_MODELS.image[0] ?? "");
  }
}

function parseProviderModelId(id: string): ResolvedModel {
  const idx = id.indexOf(":");
  if (idx <= 0 || idx === id.length - 1) return { provider: "unknown", modelId: id };
  return { provider: id.slice(0, idx), modelId: id.slice(idx + 1) };
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
      const raw = configuredModels[role];
      // Surface the exact shape from friday.yml so the UI can render the
      // primary + fallback slots correctly. An array with one entry is
      // semantically equivalent to a bare string but kept as-is to
      // preserve the user's authored form.
      let configured: string | string[] | null = null;
      if (typeof raw === "string" && raw.length > 0) {
        configured = raw;
      } else if (Array.isArray(raw)) {
        const filtered = raw.filter((v): v is string => typeof v === "string" && v.length > 0);
        if (filtered.length > 0) configured = filtered;
      }
      const resolved =
        role === "image"
          ? resolveImageRoleForGet(ctx.platformModels, configured)
          : pickLanguageResolved(ctx.platformModels, role);
      return { role, resolved, configured };
    });

    return c.json({ success: true, models, configPath });
  },
);

// Provider + model catalog used to populate the Settings page dropdown.
// The response is served from a 1h in-memory cache in @atlas/llm;
// daemon startup prewarms it so the first request is already warm.
const modelInfoFieldSchema = z.object({ id: z.string(), displayName: z.string() });
const catalogResponseSchema = z.object({
  success: z.boolean(),
  fetchedAt: z.number(),
  entries: z.array(
    z.object({
      provider: z.string(),
      credentialConfigured: z.boolean(),
      credentialEnvVar: z.string().nullable(),
      models: z.array(modelInfoFieldSchema),
      /** Image-generation models advertised by the gateway/provider, used
       * by the Settings image picker to intersect against the verified
       * capability overlay. Empty for providers with no image surface. */
      images: z.array(modelInfoFieldSchema),
      error: z.string().optional(),
    }),
  ),
});

configRoutes.get(
  "/models/catalog",
  describeRoute({
    tags: ["Config"],
    summary: "Get the model catalog (providers + models + credential status)",
    description:
      "Returns a catalog entry per registered provider with its unlock env var, the list of language models available to it, and whether the caller currently has a credential configured. Used by the Settings page to render a dropdown instead of a free-text input. Cached 1h in memory.",
    responses: {
      200: {
        description: "Catalog retrieved",
        content: { "application/json": { schema: resolver(catalogResponseSchema) } },
      },
    },
  }),
  async (c) => {
    const catalog = await getCatalog();
    return c.json({ success: true, fetchedAt: catalog.fetchedAt, entries: catalog.entries });
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

    // Build the new `models` map. Normalization rules:
    //   - null / undefined / empty-string → omit the key (use default chain).
    //   - string with content            → write as bare string.
    //   - array with one usable entry    → collapse to bare string (cleaner
    //                                      YAML, no semantic difference).
    //   - array with multiple entries    → write as array; daemon will walk
    //                                      the chain.
    //   - array with zero usable entries → omit the key.
    const newModels: Partial<Record<ModelRole, string | string[]>> = {};
    for (const role of PLATFORM_ROLES) {
      const value = incoming[role];
      if (typeof value === "string" && value.trim().length > 0) {
        newModels[role] = value.trim();
      } else if (Array.isArray(value)) {
        const cleaned = value
          .map((v) => (typeof v === "string" ? v.trim() : ""))
          .filter((v) => v.length > 0);
        if (cleaned.length === 1) {
          newModels[role] = cleaned[0];
        } else if (cleaned.length > 1) {
          newModels[role] = cleaned;
        }
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
      // readable.
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
