import { client, parseResult, type InferResponseType } from "@atlas/client/v2";

export type ProviderDetailsResponse = InferResponseType<
  (typeof client.link.v1.providers)[":id"]["$get"],
  200
>;

export interface AvailableCredential {
  id: string;
  label: string;
  displayName: string | null;
  userIdentifier: string | null;
  isDefault: boolean;
}

export interface Integration {
  provider: string;
  providerDetails: ProviderDetailsResponse;
  connected: boolean;
  paths: Array<{ path: string; credentialId?: string; provider?: string; key: string }>;
  credential?: { id: string; label: string; displayName?: string | null; createdAt: string };
  /** When unconnected and 2+ credentials exist for the provider, these are the candidates. */
  availableCredentials?: AvailableCredential[];
  /** When set, the Connect button is disabled and this message is shown as hint text. */
  disabledReason?: string;
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

  // Fetch credential summaries from Link (needed for both connected lookups and ambiguity detection)
  const credentialMap = new Map<
    string,
    { id: string; label: string; displayName?: string | null; createdAt: string }
  >();
  const credentialsByProvider = new Map<string, AvailableCredential[]>();

  const summaryRes = await parseResult(client.link.v1.summary.$get({ query: {} }));
  if (summaryRes.ok) {
    for (const cred of summaryRes.data.credentials) {
      credentialMap.set(cred.id, {
        id: cred.id,
        label: cred.label,
        displayName: cred.displayName,
        createdAt: cred.createdAt,
      });

      const existing = credentialsByProvider.get(cred.provider);
      const entry: AvailableCredential = {
        id: cred.id,
        label: cred.label,
        displayName: cred.displayName,
        userIdentifier: cred.userIdentifier,
        isDefault: cred.isDefault,
      };
      if (existing) {
        existing.push(entry);
      } else {
        credentialsByProvider.set(cred.provider, [entry]);
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
    const connected = paths.every((p) => p.credentialId !== undefined);

    // Use the first connected credential's details
    const connectedCredId = paths.find((p) => p.credentialId)?.credentialId;
    const credential = connectedCredId ? credentialMap.get(connectedCredId) : undefined;

    // Surface all credentials for this provider so the picker can offer selection + "Add new"
    const providerCreds = credentialsByProvider.get(providerId);
    const availableCredentials =
      providerCreds && providerCreds.length >= 1 ? providerCreds : undefined;

    integrations.push({
      provider: providerId,
      providerDetails: result.data,
      connected,
      paths,
      credential,
      availableCredentials,
    });
  }

  // slack-app is 1:1 with workspaces — always show Connect (install new bot),
  // never a credential picker. Also requires slack-user as a prerequisite.
  const slackAppIntegration = integrations.find((i) => i.provider === "slack-app");
  if (slackAppIntegration) {
    delete slackAppIntegration.availableCredentials;
    const slackUserCreds = credentialsByProvider.get("slack-user");
    const slackUserConnected = slackUserCreds !== undefined && slackUserCreds.length > 0;

    if (!slackUserConnected) {
      // Inject slack-user as a synthetic integration so it appears in the setup table
      const slackUserHasEntry = integrations.some((i) => i.provider === "slack-user");
      if (!slackUserHasEntry) {
        const slackUserDetails = await parseResult(
          client.link.v1.providers[":id"].$get({ param: { id: "slack-user" } }),
        );
        if (slackUserDetails.ok) {
          integrations.unshift({
            provider: "slack-user",
            providerDetails: slackUserDetails.data,
            connected: false,
            paths: [],
          });
        }
      }

      // Disable slack-app Connect until slack-user is connected
      slackAppIntegration.disabledReason = "Requires Slack organization connected";
    }
  }

  return integrations;
}
