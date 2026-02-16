/**
 * Resolves Link credentials from ConfigRequirement[] into bindings.
 *
 * Extracted from build-blueprint.ts — pure async logic, no pipeline coupling.
 */

import {
  CredentialNotFoundError,
  resolveCredentialsByProvider,
} from "@atlas/core/mcp-registry/credential-resolver";
import type { CredentialBinding } from "@atlas/schemas/workspace";
import type { ConfigRequirement } from "./classify-agents.ts";

export type { CredentialBinding };

/** A credential that could not be resolved from Link. */
export type UnresolvedCredential = {
  agentId: string;
  field: string;
  provider: string;
  reason: string;
};

/** Options for credential resolution. */
export type ResolveCredentialsOpts = {
  /** Skip Link API calls — returns all Link fields as unresolved. */
  skipLink?: boolean;
};

/**
 * Resolves Link credentials from ConfigRequirement[] into bindings.
 */
export async function resolveCredentials(
  requirements: ConfigRequirement[],
  opts?: ResolveCredentialsOpts,
): Promise<{ bindings: CredentialBinding[]; unresolved: UnresolvedCredential[] }> {
  const bindings: CredentialBinding[] = [];
  const unresolved: UnresolvedCredential[] = [];

  for (const req of requirements) {
    for (const field of req.requiredConfig) {
      if (field.source !== "link") continue;
      if (!field.provider) continue;

      if (opts?.skipLink) {
        unresolved.push({
          agentId: req.agentId,
          field: field.key,
          provider: field.provider,
          reason: "Link resolution skipped (offline mode)",
        });
        continue;
      }

      const targetType = req.integration.type === "mcp" ? ("mcp" as const) : ("agent" as const);
      const targetId = req.integration.type === "mcp" ? req.integration.serverId : req.agentId;

      try {
        const credentials = await resolveCredentialsByProvider(field.provider);
        const firstCred = credentials[0];
        if (firstCred) {
          bindings.push({
            targetType,
            targetId,
            field: field.key,
            credentialId: firstCred.id,
            provider: field.provider,
            key: "access_token",
            label: firstCred.label || undefined,
          });
        }
      } catch (error) {
        if (error instanceof CredentialNotFoundError) {
          unresolved.push({
            agentId: req.agentId,
            field: field.key,
            provider: field.provider,
            reason: `No credentials found for provider '${field.provider}'`,
          });
        } else {
          throw error;
        }
      }
    }
  }

  return { bindings, unresolved };
}
