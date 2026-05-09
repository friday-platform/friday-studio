/**
 * Link Context
 *
 * Fetches connected credentials from Link service. Used by the workspace-chat
 * `list_integrations` / `describe_integration` retrieval tools to answer
 * "is X connected?" on demand instead of inlining the per-provider status
 * into block 2 of the system prompt.
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
