/**
 * Mutation hooks for Link credential operations.
 *
 * Wraps DELETE and PATCH endpoints and invalidates credential queries
 * on success so panels stay fresh after any mutation.
 *
 * @module
 */

import { createMutation, useQueryClient } from "@tanstack/svelte-query";
import { z } from "zod";
import { linkProviderQueries } from "./link-provider-queries.ts";

// ==============================================================================
// SCHEMAS & TYPES
// ==============================================================================

const CredentialSummarySchema = z.object({
  id: z.string(),
  type: z.enum(["apikey", "oauth"]),
  provider: z.string(),
  label: z.string(),
  displayName: z.string().nullable().optional(),
  userIdentifier: z.string().nullable().optional(),
  isDefault: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  status: z.enum(["ready", "expired", "unknown"]).optional(),
});

// ==============================================================================
// MUTATION HOOKS
// ==============================================================================

/**
 * Mutation for deleting a credential.
 * Wraps `DELETE /api/link/v1/credentials/:id` via the SvelteKit proxy.
 * Invalidates credential summary queries on success.
 */
export function useDeleteCredential() {
  const queryClient = useQueryClient();

  return createMutation(() => ({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/daemon/api/link/v1/credentials/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => ({}));
        const msg =
          typeof body === "object" &&
            body !== null &&
            "error" in body &&
            typeof (body as { error: unknown }).error === "string"
            ? (body as { error: string }).error
            : `Delete failed: ${res.status}`;
        throw new Error(msg);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: linkProviderQueries.all() });
    },
  }));
}

/**
 * Mutation for replacing a credential's secret in-place.
 * Wraps `PATCH /api/link/v1/credentials/:id` with `{ secret }` via the SvelteKit proxy.
 * Invalidates credential summary queries on success.
 */
export function useUpdateCredentialSecret() {
  const queryClient = useQueryClient();

  return createMutation(() => ({
    mutationFn: async (input: { id: string; secret: Record<string, unknown> }) => {
      const res = await fetch(
        `/api/daemon/api/link/v1/credentials/${encodeURIComponent(input.id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ secret: input.secret }),
        },
      );

      if (!res.ok) {
        const body: unknown = await res.json().catch(() => ({}));
        const msg =
          typeof body === "object" &&
            body !== null &&
            "message" in body &&
            typeof (body as { message: unknown }).message === "string"
            ? (body as { message: string }).message
            : typeof body === "object" &&
                body !== null &&
                "error" in body &&
                typeof (body as { error: unknown }).error === "string"
            ? (body as { error: string }).error
            : `Update failed: ${res.status}`;
        throw new Error(msg);
      }

      return CredentialSummarySchema.parse(await res.json());
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: linkProviderQueries.all() });
    },
  }));
}
