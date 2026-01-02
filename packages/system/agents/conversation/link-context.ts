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
 * Uses flat XML with status attributes for unambiguous service state.
 *
 * @param summary - Summary response from Link service
 * @returns Formatted XML section for system prompt
 */
export function formatIntegrationsSection(summary: SummaryResponse): string {
  const { credentials, providers } = summary;

  // Build credential lookup: providerId -> label
  const credentialLabels = new Map<string, string>();
  for (const cred of credentials) {
    // If multiple credentials for same provider, join labels
    const existing = credentialLabels.get(cred.provider);
    credentialLabels.set(cred.provider, existing ? `${existing}, ${cred.label}` : cred.label);
  }

  // Build flat XML
  let section = "<integrations>\n";
  for (const provider of providers) {
    const label = credentialLabels.get(provider.id);
    if (label) {
      section += `  <service id="${provider.id}" status="ready" label="${label}"/>\n`;
    } else {
      section += `  <service id="${provider.id}" status="unconnected"/>\n`;
    }
  }
  section += "</integrations>";
  return section;
}
