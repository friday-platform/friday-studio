/**
 * Query option factories for integration-related data.
 *
 * Co-locates query key + queryFn + shared config per TKDodo's queryOptions pattern.
 * Consumers spread these into `createQuery` and add per-site config (enabled, select, etc.).
 *
 * @module
 */
import { queryOptions, skipToken } from "@tanstack/svelte-query";
import { z } from "zod";

// ==============================================================================
// SCHEMAS & TYPES
// ==============================================================================

const IntegrationStatusSchema = z.enum(["connected", "degraded", "disconnected"]);
/** Status of a single integration provider. */
export type IntegrationStatus = z.infer<typeof IntegrationStatusSchema>;

const IntegrationSourceSchema = z.enum(["link", "env", "config"]).nullable();

const IntegrationPreflightSchema = z.object({
  provider: z.string(),
  status: IntegrationStatusSchema,
  source: IntegrationSourceSchema,
  label: z.string().nullable(),
  detail: z.string().nullable(),
});

/** Single integration provider's preflight status. */
export type IntegrationPreflight = z.infer<typeof IntegrationPreflightSchema>;

const PreflightResponseSchema = z.object({ integrations: z.array(IntegrationPreflightSchema) });

// ==============================================================================
// QUERY FACTORIES
// ==============================================================================

export const integrationQueries = {
  /** Key-only entry for hierarchical invalidation of all integration queries. */
  all: () => ["daemon", "integrations"] as const,

  /** Integration preflight status for a workspace (daemon route, untyped — raw fetch). Accepts null to disable via skipToken. */
  preflight: (workspaceId: string | null) =>
    queryOptions({
      queryKey: ["daemon", "integrations", "preflight", workspaceId] as const,
      queryFn: workspaceId
        ? async () => {
            const res = await fetch(
              `/api/daemon/api/workspaces/${workspaceId}/integrations/preflight`,
            );
            if (!res.ok) throw new Error(`Integration preflight: ${res.status}`);
            const data: unknown = await res.json();
            return PreflightResponseSchema.parse(data);
          }
        : skipToken,
      staleTime: 30_000,
      retry: false,
    }),
};
