/**
 * Build a `LinkCredentialState` snapshot for one workspace's credential refs.
 *
 * `resolveWorkspaceSetupRequirements` is pure — the caller assembles the Link
 * snapshot. This helper walks the workspace's credential usages, calls Link
 * for each unique pinned id and each unique provider-only ref, and folds the
 * results into the three fields the derivation reads.
 *
 * Decision 3: transient Link errors must not flip `requires_setup` true.
 *  - provider lookup transient failure → `providerErrors`
 *  - per-id lookup transient failure → add the id to `resolvedIds`
 *    (treat as "previously-resolved still resolved" for this derivation)
 *
 * `LinkCredentialNotFoundError` is the *non*-transient case for ids: the
 * credential is gone. Leave it out of `resolvedIds` so the derivation can
 * surface it as a `stale_id` requirement (post-import) or throw (at import).
 *
 * `CredentialNotFoundError` / `InvalidProviderError` are the non-transient
 * provider cases: there are simply no credentials for the provider. Leave
 * the provider out of `defaultByProvider` (i.e. `undefined`) so the
 * derivation surfaces a `no_default` requirement.
 */

import type { WorkspaceConfig } from "@atlas/config";
import { extractCredentials } from "@atlas/config/mutations";
import {
  CredentialNotFoundError,
  fetchLinkCredential,
  InvalidProviderError,
  LinkCredentialNotFoundError,
  resolveCredentialsByProvider,
} from "@atlas/core/mcp-registry/credential-resolver";
import { createLogger } from "@atlas/logger";
import type { LinkCredentialState } from "@atlas/workspace";

const assemblyLogger = createLogger({ component: "link-credential-state" });

export async function assembleLinkCredentialState(
  config: WorkspaceConfig,
): Promise<LinkCredentialState> {
  const usages = extractCredentials(config);
  const pinnedIds = new Set<string>();
  const providerOnly = new Set<string>();
  for (const usage of usages) {
    if (usage.credentialId) pinnedIds.add(usage.credentialId);
    else if (usage.provider) providerOnly.add(usage.provider);
  }

  const resolvedIds = new Set<string>();
  const defaultByProvider: Record<string, string | null | undefined> = {};
  const providerErrors = new Set<string>();

  const idLookups = Array.from(pinnedIds).map(async (id) => {
    try {
      await fetchLinkCredential(id, assemblyLogger);
      resolvedIds.add(id);
    } catch (error) {
      if (error instanceof LinkCredentialNotFoundError) return;
      // Transient (network, refresh hiccup, etc.) — Decision 3.
      resolvedIds.add(id);
    }
  });

  const providerLookups = Array.from(providerOnly).map(async (provider) => {
    try {
      const credentials = await resolveCredentialsByProvider(provider);
      const defaultCred = credentials.find((c) => c.isDefault);
      defaultByProvider[provider] = defaultCred ? defaultCred.id : null;
    } catch (error) {
      if (error instanceof CredentialNotFoundError || error instanceof InvalidProviderError) {
        // No credentials for this provider — leave `defaultByProvider[p]` as
        // `undefined` so the derivation surfaces a `no_default` requirement.
        return;
      }
      providerErrors.add(provider);
    }
  });

  await Promise.all([...idLookups, ...providerLookups]);

  return { defaultByProvider, resolvedIds, providerErrors };
}
