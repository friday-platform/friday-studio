/**
 * TanStack Query hook for fetching integration preflight status from the daemon.
 * Checks all credential sources (Link, env vars, config literals) and reports
 * operational status per provider.
 *
 * @module
 */
import { createQuery } from "@tanstack/svelte-query";
import { z } from "zod";

// ==============================================================================
// SCHEMAS & TYPES
// ==============================================================================

const IntegrationStatusSchema = z.enum(["connected", "degraded", "disconnected"]);
export type IntegrationStatus = z.infer<typeof IntegrationStatusSchema>;

const IntegrationSourceSchema = z.enum(["link", "env", "config"]).nullable();

const IntegrationPreflightSchema = z.object({
  provider: z.string(),
  status: IntegrationStatusSchema,
  source: IntegrationSourceSchema,
  label: z.string().nullable(),
  detail: z.string().nullable(),
});
export type IntegrationPreflight = z.infer<typeof IntegrationPreflightSchema>;

const PreflightResponseSchema = z.object({ integrations: z.array(IntegrationPreflightSchema) });
type PreflightResponse = z.infer<typeof PreflightResponseSchema>;

// ==============================================================================
// HOOK
// ==============================================================================

/**
 * Fetches integration preflight status for a workspace.
 * Reports credential resolution status across Link, env vars, and config literals.
 *
 * @param workspaceId - Reactive getter returning the current workspace ID, or null when none is selected
 */
export function useIntegrationsPreflight(workspaceId: () => string | null) {
  return createQuery(() => {
    const id = workspaceId();
    return {
      queryKey: ["integrations", "preflight", id],
      queryFn: async (): Promise<PreflightResponse> => {
        const res = await fetch(`/api/daemon/api/workspaces/${id}/integrations/preflight`);
        if (!res.ok) throw new Error(`Integration preflight: ${res.status}`);
        const data: unknown = await res.json();
        return PreflightResponseSchema.parse(data);
      },
      enabled: id !== null,
      staleTime: 30_000,
      retry: false,
    };
  });
}
