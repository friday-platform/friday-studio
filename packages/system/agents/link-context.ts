/**
 * Link Context
 *
 * Fetches and formats connected credentials from Link service for injection
 * into conversation agent system prompt.
 */

import { client, type InferResponseType, parseResult } from "@atlas/client/v2";
import { mcpServersRegistry } from "@atlas/core/mcp-registry/registry-consolidated";
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
      logger.debug("Link summary fetched", {
        providerIds: result.data.providers.map((p: { id: string }) => p.id),
        credentialProviders: result.data.credentials.map((c: { provider: string }) => c.provider),
      });
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
 * Includes urlDomains for URL-to-MCP mapping.
 *
 * @param summary - Summary response from Link service
 * @param options - Formatting options
 * @param options.includeLabels - Include credential labels in output (default: true).
 *   Set to false for planner context where credential identity is irrelevant.
 * @returns Formatted XML section for system prompt
 */
export function formatIntegrationsSection(
  summary: SummaryResponse,
  options?: { includeLabels?: boolean },
): string {
  const { credentials, providers } = summary;
  const includeLabels = options?.includeLabels ?? true;

  // Group credentials by provider
  const credsByProvider = new Map<string, typeof credentials>();
  for (const cred of credentials) {
    const list = credsByProvider.get(cred.provider) ?? [];
    list.push(cred);
    credsByProvider.set(cred.provider, list);
  }

  // Build flat XML with urlDomains from MCP registry
  let section = "<integrations>\n";
  for (const provider of providers) {
    const mcpEntry = mcpServersRegistry.servers[provider.id];
    const urlDomains = mcpEntry?.urlDomains?.join(",") ?? "";
    const providerCreds = credsByProvider.get(provider.id);

    if (!providerCreds || providerCreds.length === 0) {
      section += `  <service id="${provider.id}" status="unconnected" urlDomains="${urlDomains}"/>\n`;
    } else if (!includeLabels) {
      section += `  <service id="${provider.id}" status="ready" urlDomains="${urlDomains}"/>\n`;
    } else {
      for (const cred of providerCreds) {
        const defaultAttr = cred.isDefault ? ` default="true"` : "";
        section += `  <service id="${provider.id}" status="ready" label="${cred.label}"${defaultAttr} urlDomains="${urlDomains}"/>\n`;
      }
    }
  }
  section += "</integrations>";
  return section;
}
