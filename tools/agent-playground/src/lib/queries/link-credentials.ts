/**
 * Mutation hooks for Link credential operations.
 *
 * Wraps PUT, DELETE, and PATCH endpoints and invalidates credential queries
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

const ApiKeyCreateResponseSchema = z.object({ id: z.string().min(1) });

/**
 * Tolerant parser for Link error responses. Link emits `{ message }` for
 * validation failures and `{ error }` for handler-level errors; older
 * routes mix the two. `message` wins when both are present.
 */
const ErrorBodySchema = z.object({
  message: z.string().optional(),
  error: z.string().optional(),
});

/** Pull a user-facing message from a failed response, or fall back to status. */
async function readErrorMessage(res: Response, fallback: string): Promise<string> {
  const raw: unknown = await res.json().catch(() => ({}));
  const parsed = ErrorBodySchema.safeParse(raw);
  return parsed.success ? parsed.data.message ?? parsed.data.error ?? fallback : fallback;
}

// ==============================================================================
// MUTATION HOOKS
// ==============================================================================

/**
 * Mutation for creating a new API-key credential.
 * Wraps `PUT /api/link/v1/credentials/apikey` via the SvelteKit proxy.
 * Invalidates credential summary queries on success.
 */
export function useCreateApiKeyCredential() {
  const queryClient = useQueryClient();

  return createMutation(() => ({
    mutationFn: async (
      input: { provider: string; label: string; secret: Record<string, string> },
    ) => {
      const res = await fetch(`/api/daemon/api/link/v1/credentials/apikey`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });

      if (!res.ok) {
        throw new Error(await readErrorMessage(res, `Create failed: ${res.status}`));
      }

      return ApiKeyCreateResponseSchema.parse(await res.json()).id;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: linkProviderQueries.all() });
    },
  }));
}

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
        throw new Error(await readErrorMessage(res, `Delete failed: ${res.status}`));
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
        throw new Error(await readErrorMessage(res, `Update failed: ${res.status}`));
      }

      return CredentialSummarySchema.parse(await res.json());
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: linkProviderQueries.all() });
    },
  }));
}
