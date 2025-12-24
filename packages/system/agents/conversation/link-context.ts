/**
 * Link Context
 *
 * Fetches and formats connected credentials from Link service for injection
 * into conversation agent system prompt.
 */

import { client, type InferResponseType, parseResult } from "@atlas/client/v2";
import type { Logger } from "@atlas/logger";

/**
 * Type inferred from Link's GET /v1/summary endpoint (success response only)
 */
type SummaryResponseRaw = InferResponseType<typeof client.link.v1.summary.$get>;
type SummaryResponse = Extract<SummaryResponseRaw, { providers: unknown }>;

/**
 * Fetch Link summary using typed Hono client.
 * Returns null on any error (network, 404, etc.) - caller should handle gracefully.
 *
 * @param logger - Logger instance for error reporting
 * @returns Summary response or null on error
 */
export async function fetchLinkSummary(logger: Logger): Promise<SummaryResponse | null> {
  try {
    const result = await parseResult(client.link.v1.summary.$get({ query: {} }));
    if (!result.ok) {
      logger.debug("Failed to fetch Link summary", { error: result.error });
      return null;
    }
    // Narrow to success type (has providers array)
    if ("providers" in result.data) {
      return result.data;
    }
    return null;
  } catch (error) {
    logger.debug("Error fetching Link summary", { error });
    return null;
  }
}

/**
 * Format credentials into system prompt section.
 * Groups credentials by provider and separates active credentials from available providers.
 *
 * @param summary - Summary response from Link service
 * @returns Formatted markdown section for system prompt
 */
export function formatLinkedCredentialsSection(summary: SummaryResponse): string {
  const { credentials, providers } = summary;

  // Group credentials by provider
  const credentialsByProvider = new Map<string, Array<{ label: string; type: string }>>();
  for (const cred of credentials) {
    if (!credentialsByProvider.has(cred.provider)) {
      credentialsByProvider.set(cred.provider, []);
    }
    credentialsByProvider.get(cred.provider)?.push({ label: cred.label, type: cred.type });
  }

  // Build section
  let section = `<linked_credentials>`;

  // Connected services section (providers with credentials)
  if (credentialsByProvider.size > 0) {
    section += `\n## Connected Services\n`;
    for (const [providerId, creds] of credentialsByProvider) {
      const provider = providers.find((p) => p.id === providerId);
      const displayName = provider?.displayName ?? providerId;
      const labels = creds.map((c) => c.label).join(", ");
      section += `- ${displayName} (ID: ${providerId}): ${labels}\n`;
    }
  }

  // Available services section (providers without credentials)
  const availableProviders = providers.filter((p) => !credentialsByProvider.has(p.id));
  if (availableProviders.length > 0) {
    section += `\n## Available Services\n`;
    for (const provider of availableProviders) {
      section += `- ${provider.displayName} (ID: ${provider.id}, type: ${provider.type})\n`;
    }
  }

  section += `</linked_credentials>`;
  return section;
}
