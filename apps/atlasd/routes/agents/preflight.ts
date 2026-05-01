/**
 * Per-agent credential preflight route.
 *
 * Checks credential resolution status for a single agent's environment config
 * and reports per-credential status (Link, env var, or disconnected).
 */

import process from "node:process";
import {
  type CredentialSummary,
  InvalidProviderError,
  resolveCredentialsByProvider,
} from "@atlas/core/mcp-registry/credential-resolver";
import { createLogger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";
import { describeRoute, resolver, validator } from "hono-openapi";
import { z } from "zod";
import { daemonFactory } from "../../src/factory.ts";
import { agentIdParamsSchema, errorResponseSchema } from "./schemas.ts";

const log = createLogger({ component: "agent-preflight" });

// ==============================================================================
// SCHEMAS
// ==============================================================================

const credentialStatusSchema = z.object({
  envKey: z.string(),
  required: z.boolean(),
  provider: z.string().nullable(),
  status: z.enum(["connected", "disconnected"]),
  source: z.enum(["link", "env"]).nullable(),
  label: z.string().nullable(),
  linkRef: z.object({ provider: z.string(), key: z.string() }).nullable(),
});

const preflightResponseSchema = z.object({
  agentId: z.string(),
  credentials: z.array(credentialStatusSchema),
});

// ==============================================================================
// RESOLUTION HELPERS
// ==============================================================================

interface CredentialStatus {
  envKey: string;
  required: boolean;
  provider: string | null;
  status: "connected" | "disconnected";
  source: "link" | "env" | null;
  label: string | null;
  linkRef: { provider: string; key: string } | null;
}

/**
 * Resolve a Link credential ref: check Link service first, fall back to env var.
 */
async function resolveLinkCredential(
  envKey: string,
  linkRef: { provider: string; key: string },
  required: boolean,
): Promise<CredentialStatus> {
  const base = { envKey, required, provider: linkRef.provider, linkRef };

  try {
    const credentials: CredentialSummary[] = await resolveCredentialsByProvider(linkRef.provider);
    const credential = credentials[0];
    if (credential) {
      return { ...base, status: "connected", source: "link", label: credential.label ?? null };
    }
  } catch (error) {
    // InvalidProviderError means provider isn't registered — no fallback makes sense
    if (error instanceof InvalidProviderError) {
      return { ...base, status: "disconnected", source: null, label: null };
    }
    // Other errors (network, etc.) — fall through to env check
  }

  // Fall back to env var
  return resolveEnvVar(envKey, required, linkRef.provider, linkRef);
}

/**
 * Resolve a plain environment variable credential.
 */
function resolveEnvVar(
  envKey: string,
  required: boolean,
  provider: string | null = null,
  linkRef: { provider: string; key: string } | null = null,
): CredentialStatus {
  const present = process.env[envKey] !== undefined && process.env[envKey] !== "";
  return {
    envKey,
    required,
    provider,
    status: present ? "connected" : "disconnected",
    source: present ? "env" : null,
    label: present ? "env" : null,
    linkRef,
  };
}

// ==============================================================================
// ROUTE
// ==============================================================================

const getAgentPreflight = daemonFactory.createApp();

getAgentPreflight.get(
  "/:id/preflight",
  describeRoute({
    tags: ["Agents"],
    summary: "Agent credential preflight",
    description: "Returns per-credential resolution status for a single agent",
    responses: {
      200: {
        description: "Credential preflight results",
        content: { "application/json": { schema: resolver(preflightResponseSchema) } },
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

      const envConfig = agent.environmentConfig;
      const credentials: CredentialStatus[] = [];

      // Resolve required fields
      const requiredFields = envConfig?.required ?? [];
      const requiredPromises = requiredFields.map((field) => {
        if (field.linkRef) {
          return resolveLinkCredential(field.name, field.linkRef, true);
        }
        return Promise.resolve(resolveEnvVar(field.name, true));
      });

      // Resolve optional fields (no linkRef on optional fields per schema)
      const optionalFields = envConfig?.optional ?? [];
      const optionalPromises = optionalFields.map((field) =>
        Promise.resolve(resolveEnvVar(field.name, false)),
      );

      const resolved = await Promise.all([...requiredPromises, ...optionalPromises]);
      credentials.push(...resolved);

      const response = preflightResponseSchema.parse({ agentId: id, credentials });
      return c.json(response);
    } catch (error) {
      log.error("Agent preflight check failed", { error: stringifyError(error) });
      return c.json({ error: `Preflight check failed: ${stringifyError(error)}` }, 500);
    }
  },
);

export { getAgentPreflight };
