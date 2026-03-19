/**
 * Resolves Link credentials from ConfigRequirement[] into bindings.
 *
 * Extracted from build-blueprint.ts — pure async logic, no pipeline coupling.
 */

import {
  CredentialNotFoundError,
  type CredentialSummary,
  resolveCredentialsByProvider,
} from "@atlas/core/mcp-registry/credential-resolver";
import type { CredentialBinding, ProviderCredentialCandidates } from "@atlas/schemas/workspace";
import type { ConfigRequirement } from "./classify-agents.ts";

export type { CredentialBinding, ProviderCredentialCandidates };

/** A credential that could not be resolved from Link. */
export type UnresolvedCredential = {
  provider: string;
  targetType: "mcp" | "agent";
  targetId: string;
  field: string;
} & ({ reason: "not_found" } | { reason: "skipped" });

/** Options for credential resolution. */
export type ResolveCredentialsOpts = {
  /** Skip Link API calls — returns all Link fields as unresolved. */
  skipLink?: boolean;
};

/** Result from resolveCredentials(). */
export type ResolveCredentialsResult = {
  bindings: CredentialBinding[];
  unresolved: UnresolvedCredential[];
  candidates: ProviderCredentialCandidates[];
};

/**
 * Resolves Link credentials from ConfigRequirement[] into bindings.
 *
 * When a provider has 2+ credentials, all candidates are returned so the
 * plan approval UI can render a picker. If no default exists (ambiguous),
 * the first candidate is auto-selected into bindings instead of leaving it
 * unresolved — the user can override via the picker before approving.
 */
export async function resolveCredentials(
  requirements: ConfigRequirement[],
  opts?: ResolveCredentialsOpts,
): Promise<ResolveCredentialsResult> {
  const bindings: CredentialBinding[] = [];
  const unresolved: UnresolvedCredential[] = [];
  /** Track candidates by provider to deduplicate across fields. */
  const candidatesByProvider = new Map<string, ProviderCredentialCandidates>();

  /** Cache API responses by provider to avoid duplicate HTTP calls. */
  const fetchCache = new Map<string, CredentialSummary[]>();

  for (const req of requirements) {
    const targetType = req.integration.type === "mcp" ? ("mcp" as const) : ("agent" as const);
    const targetId = req.integration.type === "mcp" ? req.integration.serverId : req.agentId;

    for (const field of req.requiredConfig) {
      if (field.source !== "link") continue;
      if (!field.provider) continue;

      if (opts?.skipLink) {
        unresolved.push({
          provider: field.provider,
          targetType,
          targetId,
          field: field.key,
          reason: "skipped",
        });
        continue;
      }

      try {
        let credentials = fetchCache.get(field.provider);
        if (!credentials) {
          credentials = await resolveCredentialsByProvider(field.provider);
          fetchCache.set(field.provider, credentials);
        }

        // Capture candidates when provider has 2+ credentials (deduplicate by provider)
        if (credentials.length >= 2 && !candidatesByProvider.has(field.provider)) {
          candidatesByProvider.set(field.provider, {
            provider: field.provider,
            candidates: credentials.map((c) => ({
              id: c.id,
              label: c.label,
              displayName: c.displayName,
              userIdentifier: c.userIdentifier,
              isDefault: c.isDefault,
            })),
          });
        }

        // Select: single cred → use it; multiple → prefer default, fall back to first
        const selected =
          credentials.length === 1
            ? credentials[0]
            : (credentials.find((c) => c.isDefault) ?? credentials[0]);

        if (!selected) {
          // Shouldn't happen (resolveCredentialsByProvider throws on empty), but guard
          unresolved.push({
            provider: field.provider,
            targetType,
            targetId,
            field: field.key,
            reason: "not_found",
          });
          continue;
        }

        bindings.push({
          targetType,
          targetId,
          field: field.key,
          credentialId: selected.id,
          provider: field.provider,
          key: field.secretKey ?? "access_token",
          label: selected.label || undefined,
        });
      } catch (error) {
        if (error instanceof CredentialNotFoundError) {
          unresolved.push({
            provider: field.provider,
            targetType,
            targetId,
            field: field.key,
            reason: "not_found",
          });
        } else {
          throw error;
        }
      }
    }
  }

  return { bindings, unresolved, candidates: [...candidatesByProvider.values()] };
}
