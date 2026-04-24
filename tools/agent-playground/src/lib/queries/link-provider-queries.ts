/**
 * Query option factories for Link provider metadata and credential summaries.
 *
 * Co-locates query key + queryFn + shared config per TKDodo's queryOptions pattern.
 *
 * @module
 */

import { queryOptions } from "@tanstack/svelte-query";
import { z } from "zod";

// ==============================================================================
// SCHEMAS & TYPES
// ==============================================================================

const ProviderDetailsSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  type: z.enum(["oauth", "apikey", "app_install"]),
  description: z.string(),
  setupInstructions: z.string().optional(),
  secretSchema: z
    .object({
      properties: z.record(z.string(), z.object({}).passthrough()).optional(),
      required: z.array(z.string()).optional(),
    })
    .optional(),
});

export type ProviderDetails = z.infer<typeof ProviderDetailsSchema>;

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

const SummaryResponseSchema = z.object({
  providers: z.array(
    z.object({
      id: z.string(),
      displayName: z.string(),
      type: z.enum(["oauth", "apikey", "app_install"]),
    }),
  ),
  credentials: z.array(CredentialSummarySchema),
});

// ==============================================================================
// QUERY FACTORIES
// ==============================================================================

export const linkProviderQueries = {
  /** Key-only entry for hierarchical invalidation of all Link provider queries. */
  all: () => ["daemon", "link", "providers"] as const,

  /** Provider metadata (type, displayName, description, secretSchema). */
  providerDetails: (providerId: string) =>
    queryOptions({
      queryKey: ["daemon", "link", "providers", "details", providerId] as const,
      queryFn: async () => {
        const res = await fetch(
          `/api/daemon/api/link/v1/providers/${encodeURIComponent(providerId)}`,
        );
        if (!res.ok) throw new Error(`Failed to fetch provider details: ${res.status}`);
        return ProviderDetailsSchema.parse(await res.json());
      },
      staleTime: 60_000,
    }),

  /** Credential summaries for a provider, including status. */
  credentialsByProvider: (providerId: string) =>
    queryOptions({
      queryKey: ["daemon", "link", "providers", "credentials", providerId] as const,
      queryFn: async () => {
        const url = new URL("/api/daemon/api/link/v1/summary", globalThis.location.origin);
        url.searchParams.set("provider", providerId);
        const res = await fetch(url.href);
        if (!res.ok) throw new Error(`Failed to fetch credential summary: ${res.status}`);
        const data = SummaryResponseSchema.parse(await res.json());
        return data.credentials;
      },
      staleTime: 30_000,
    }),
};
