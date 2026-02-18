import { client, parseResult, type InferResponseType } from "@atlas/client/v2";

export type ProviderDetailsResponse = InferResponseType<
  (typeof client.link.v1.providers)[":id"]["$get"],
  200
>;

export interface Integration {
  provider: string;
  providerDetails: ProviderDetailsResponse;
  connected: boolean;
  paths: Array<{ path: string; credentialId?: string; provider?: string; key: string }>;
  credential?: { id: string; label: string; displayName?: string | null; createdAt: string };
}

/**
 * Load integrations for a workspace by fetching config credentials,
 * grouping by provider, and enriching with provider + credential details.
 */
export async function loadWorkspaceIntegrations(workspaceId: string): Promise<Integration[]> {
  const credentialsRes = await parseResult(client.workspaceConfig(workspaceId).credentials.$get());

  if (!credentialsRes.ok) return [];

  const credentials = credentialsRes.data.credentials;
  if (credentials.length === 0) return [];

  // Group credential paths by provider
  const byProvider = new Map<
    string,
    Array<{ path: string; credentialId?: string; provider?: string; key: string }>
  >();

  for (const cred of credentials) {
    const provider = cred.provider;
    if (!provider) continue;

    const existing = byProvider.get(provider);
    if (existing) {
      existing.push(cred);
    } else {
      byProvider.set(provider, [cred]);
    }
  }

  const providerIds = [...byProvider.keys()];

  // Fetch provider details in parallel
  const providerResults = await Promise.all(
    providerIds.map((id) => parseResult(client.link.v1.providers[":id"].$get({ param: { id } }))),
  );

  // Collect unique credentialIds for connected integrations
  const credentialIds = new Set<string>();
  for (const paths of byProvider.values()) {
    for (const p of paths) {
      if (p.credentialId) credentialIds.add(p.credentialId);
    }
  }

  // Fetch credential summaries from Link
  const credentialMap = new Map<
    string,
    { id: string; label: string; displayName?: string | null; createdAt: string }
  >();

  if (credentialIds.size > 0) {
    const summaryRes = await parseResult(client.link.v1.summary.$get({ query: {} }));
    if (summaryRes.ok) {
      for (const cred of summaryRes.data.credentials) {
        if (credentialIds.has(cred.id)) {
          credentialMap.set(cred.id, {
            id: cred.id,
            label: cred.label,
            displayName: cred.displayName,
            createdAt: cred.createdAt,
          });
        }
      }
    }
  }

  const integrations: Integration[] = [];

  for (let i = 0; i < providerIds.length; i++) {
    const providerId = providerIds[i];
    if (!providerId) continue;

    const result = providerResults[i];
    if (!result || !result.ok) continue;

    const paths = byProvider.get(providerId)!;

    // Use the first connected credential's details
    const connectedCredId = paths.find((p) => p.credentialId)?.credentialId;
    const credential = connectedCredId ? credentialMap.get(connectedCredId) : undefined;

    integrations.push({
      provider: providerId,
      providerDetails: result.data,
      connected: paths.every((p) => p.credentialId !== undefined),
      paths,
      credential,
    });
  }

  return integrations;
}
