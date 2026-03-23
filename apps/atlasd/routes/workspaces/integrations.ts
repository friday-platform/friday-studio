/**
 * Integration preflight routes.
 *
 * Checks credential resolution status across all sources (Link, env vars, config literals)
 * and reports operational status per provider.
 */

import process from "node:process";
import { type LinkCredentialRef, LinkCredentialRefSchema } from "@atlas/agent-sdk";
import type { WorkspaceConfig } from "@atlas/config";
import {
  type CredentialSummary,
  resolveCredentialsByProvider,
} from "@atlas/core/mcp-registry/credential-resolver";
import { createLogger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";
import { z } from "zod";
import { daemonFactory } from "../../src/factory.ts";

const log = createLogger({ component: "integrations-preflight" });

// ==============================================================================
// SCHEMAS
// ==============================================================================

const IntegrationStatusSchema = z.enum(["connected", "degraded", "disconnected"]);
type IntegrationStatus = z.infer<typeof IntegrationStatusSchema>;

const IntegrationSourceSchema = z.enum(["link", "env", "config"]).nullable();
type IntegrationSource = z.infer<typeof IntegrationSourceSchema>;

const IntegrationPreflightSchema = z.object({
  provider: z.string(),
  status: IntegrationStatusSchema,
  source: IntegrationSourceSchema,
  label: z.string().nullable(),
  detail: z.string().nullable(),
});

const PreflightResponseSchema = z.object({ integrations: z.array(IntegrationPreflightSchema) });

// ==============================================================================
// ENV VALUE CLASSIFICATION
// ==============================================================================

/** Type guard for LinkCredentialRef env values. */
function isLinkCredentialRef(value: unknown): value is LinkCredentialRef {
  return LinkCredentialRefSchema.safeParse(value).success;
}

interface ResolvedIntegration {
  provider: string;
  status: IntegrationStatus;
  source: IntegrationSource;
  label: string | null;
  detail: string | null;
}

/**
 * Extract all env value entries across MCP servers and agents, grouped by provider.
 * Returns a map of provider -> env entries to check.
 */
function collectEnvEntries(
  config: WorkspaceConfig,
): Map<string, Array<{ envKey: string; value: string | LinkCredentialRef }>> {
  const byProvider = new Map<
    string,
    Array<{ envKey: string; value: string | LinkCredentialRef }>
  >();

  function addEntry(provider: string, envKey: string, value: string | LinkCredentialRef) {
    const entries = byProvider.get(provider) ?? [];
    entries.push({ envKey, value });
    byProvider.set(provider, entries);
  }

  // Walk MCP server env vars
  const servers = config.tools?.mcp?.servers ?? {};
  for (const server of Object.values(servers)) {
    const env = server.env ?? {};
    for (const [envKey, value] of Object.entries(env)) {
      if (isLinkCredentialRef(value)) {
        const provider = value.provider ?? value.id ?? envKey;
        addEntry(provider, envKey, value);
      } else if (typeof value === "string") {
        if (value === "auto" || value === "from_environment") {
          addEntry(deriveProvider(envKey), envKey, value);
        } else if (value.length > 0) {
          addEntry(deriveProvider(envKey), envKey, value);
        }
      }
    }
  }

  // Walk agent env vars
  const agents = config.agents ?? {};
  for (const [, agent] of Object.entries(agents)) {
    if (agent.type !== "atlas") continue;
    const env = agent.env ?? {};
    for (const [envKey, value] of Object.entries(env)) {
      if (isLinkCredentialRef(value)) {
        const provider = value.provider ?? value.id ?? envKey;
        addEntry(provider, envKey, value);
      } else if (typeof value === "string") {
        if (value === "auto" || value === "from_environment") {
          addEntry(deriveProvider(envKey), envKey, value);
        } else if (value.length > 0) {
          addEntry(deriveProvider(envKey), envKey, value);
        }
      }
    }
  }

  return byProvider;
}

/**
 * Resolve a single Link credential ref to its status.
 * Checks Link service first, then falls back to process.env for the env key.
 * This way a workspace "works" if either source provides the credential.
 */
async function resolveLinkRef(
  ref: LinkCredentialRef,
  envKey: string,
): Promise<ResolvedIntegration> {
  const provider = ref.provider ?? ref.id ?? "unknown";
  try {
    let credentials: CredentialSummary[];
    if (ref.provider) {
      credentials = await resolveCredentialsByProvider(ref.provider);
    } else {
      // id-only ref — can't check via summary, fall back to connected assumption
      return { provider, status: "connected", source: "link", label: null, detail: null };
    }

    const credential = credentials[0];
    if (!credential) {
      // Link doesn't have it — check env var fallback
      return resolveEnvFallback(provider, envKey);
    }

    return {
      provider,
      status: "connected",
      source: "link",
      label: credential.label ?? null,
      detail: null,
    };
  } catch {
    // Link resolution failed — check env var fallback
    return resolveEnvFallback(provider, envKey);
  }
}

/** Fall back to process.env when Link credential is unavailable. */
function resolveEnvFallback(provider: string, envKey: string): ResolvedIntegration {
  const present = process.env[envKey] !== undefined && process.env[envKey] !== "";
  if (present) {
    return { provider, status: "connected", source: "env", label: "env", detail: null };
  }
  return {
    provider,
    status: "disconnected",
    source: null,
    label: null,
    detail: `No Link credential or '${envKey}' env var found`,
  };
}

/**
 * Derive a provider name from an env key.
 * Strips common suffixes: ANTHROPIC_API_KEY -> anthropic, GITHUB_TOKEN -> github
 */
function deriveProvider(envKey: string): string {
  const cleaned = envKey
    .replace(/_API_KEY$/i, "")
    .replace(/_TOKEN$/i, "")
    .replace(/_SECRET$/i, "")
    .replace(/_KEY$/i, "")
    .toLowerCase();
  return cleaned || envKey.toLowerCase();
}

/** Resolve a literal config value — always connected. */
function resolveConfigRef(provider: string): ResolvedIntegration {
  return { provider, status: "connected", source: "config", label: "configured", detail: null };
}

/** Resolve an env var ref ("auto" or "from_environment") to its status. */
function resolveEnvRef(provider: string, envKey: string): ResolvedIntegration {
  const present = process.env[envKey] !== undefined && process.env[envKey] !== "";
  return {
    provider,
    status: present ? "connected" : "disconnected",
    source: present ? "env" : null,
    label: present ? "env" : null,
    detail: present ? null : `Environment variable '${envKey}' is not set`,
  };
}

/** Pick the best status when multiple entries reference the same provider. */
const STATUS_PRIORITY: Record<IntegrationStatus, number> = {
  connected: 2,
  degraded: 1,
  disconnected: 0,
};

function pickBest(results: ResolvedIntegration[]): ResolvedIntegration {
  return results.reduce((best, current) =>
    STATUS_PRIORITY[current.status] > STATUS_PRIORITY[best.status] ? current : best,
  );
}

// ==============================================================================
// ROUTE
// ==============================================================================

const integrationRoutes = daemonFactory.createApp().get("/preflight", async (c) => {
  const workspaceId = c.req.param("workspaceId");
  if (!workspaceId) {
    return c.json({ error: "Missing workspaceId" }, 400);
  }
  const ctx = c.get("app");

  try {
    const manager = ctx.getWorkspaceManager();
    const workspace = await manager.find({ id: workspaceId });
    if (!workspace) {
      return c.json(
        { success: false, error: "not_found", entityType: "workspace", entityId: workspaceId },
        404,
      );
    }

    const config = await manager.getWorkspaceConfig(workspace.id);
    if (!config) {
      return c.json(
        { success: false, error: "internal", message: "Failed to load workspace configuration" },
        500,
      );
    }

    const byProvider = collectEnvEntries(config.workspace);
    const results: ResolvedIntegration[] = [];

    // Resolve all providers in parallel
    const providerPromises = Array.from(byProvider.entries()).map(async ([provider, entries]) => {
      const entryResults: ResolvedIntegration[] = [];

      for (const entry of entries) {
        if (isLinkCredentialRef(entry.value)) {
          entryResults.push(await resolveLinkRef(entry.value, entry.envKey));
        } else if (entry.value === "auto" || entry.value === "from_environment") {
          entryResults.push(resolveEnvRef(provider, entry.envKey));
        } else if (typeof entry.value === "string" && entry.value.length > 0) {
          entryResults.push(resolveConfigRef(provider));
        }
      }

      if (entryResults.length === 0) {
        // No resolvable entries — disconnected
        entryResults.push({
          provider,
          status: "disconnected",
          source: null,
          label: null,
          detail: "No credential source configured",
        });
      }

      return pickBest(entryResults);
    });

    const resolved = await Promise.all(providerPromises);
    results.push(...resolved);

    const response = PreflightResponseSchema.parse({ integrations: results });
    return c.json(response);
  } catch (error) {
    log.error("Preflight check failed", { workspaceId, error: stringifyError(error) });
    return c.json(
      {
        success: false,
        error: "internal",
        message: `Preflight check failed: ${stringifyError(error)}`,
      },
      500,
    );
  }
});

export { integrationRoutes };
export type IntegrationRoutes = typeof integrationRoutes;
