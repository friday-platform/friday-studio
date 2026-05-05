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
 *
 * Phase 6 partial cut-over: only `status="ready"` entries are inlined.
 * The `unconnected` set lives behind the `list_integrations` tool —
 * the model pulls when the user mentions a service that isn't in the
 * inlined block. This trims a long tail (30+ providers without any
 * credentials) without losing operational visibility for services the
 * user has actually connected.
 *
 * @param summary - Summary response from Link service
 * @param options - Formatting options
 * @param options.includeLabels - Include credential labels in output (default: true).
 *   Set to false for planner context where credential identity is irrelevant.
 * @returns Formatted XML section for system prompt, or empty string when
 *   no credentials are connected (skip the block entirely in that case).
 */
export function formatIntegrationsSection(
  summary: SummaryResponse,
  options?: { includeLabels?: boolean },
): string {
  const { credentials, providers } = summary;
  const includeLabels = options?.includeLabels ?? true;

  if (credentials.length === 0) return "";

  // Group credentials by provider
  const credsByProvider = new Map<string, typeof credentials>();
  for (const cred of credentials) {
    const list = credsByProvider.get(cred.provider) ?? [];
    list.push(cred);
    credsByProvider.set(cred.provider, list);
  }

  // Build flat XML with urlDomains from MCP registry. Only emit
  // `status="ready"` entries — unconnected providers are pull-only via
  // `list_integrations`.
  const lines: string[] = ["<integrations>"];
  for (const provider of providers) {
    const providerCreds = credsByProvider.get(provider.id);
    if (!providerCreds || providerCreds.length === 0) continue;

    const mcpEntry = mcpServersRegistry.servers[provider.id];
    const urlDomains = mcpEntry?.urlDomains?.join(",") ?? "";

    if (!includeLabels) {
      lines.push(`  <service id="${provider.id}" status="ready" urlDomains="${urlDomains}"/>`);
    } else {
      for (const cred of providerCreds) {
        const defaultAttr = cred.isDefault ? ` default="true"` : "";
        lines.push(
          `  <service id="${provider.id}" status="ready" label="${cred.label}"${defaultAttr} urlDomains="${urlDomains}"/>`,
        );
      }
    }
  }
  lines.push(
    "<note>Only connected services are listed above. For services the user mentions that aren't shown, call `list_integrations({status: \"unconnected\"})` to check what's available to connect.</note>",
  );
  lines.push("</integrations>");
  return lines.join("\n");
}
