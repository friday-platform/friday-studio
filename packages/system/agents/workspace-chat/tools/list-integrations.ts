/**
 * `list_integrations` — list connected/available external services for
 * this workspace. Replaces the auto-injected `<integrations>` block as
 * a pull-style retrieval tool.
 *
 * Provenance: `system-config` (the Link service is internal authoritative
 * state — it just reports back what credentials/providers are wired).
 */

import type { AtlasTools } from "@atlas/agent-sdk";
import type { Logger } from "@atlas/logger";
import { tool } from "ai";
import { z } from "zod";
import { fetchLinkSummary } from "../../link-context.ts";
import { envelope, type ReadResponse } from "./envelope.ts";

const StatusFilterSchema = z.enum(["ready", "unconnected", "all"]).default("all");

const ListIntegrationsInput = z.object({
  status: StatusFilterSchema.optional().describe(
    "Filter by credential status. `ready` = connected. `unconnected` = available providers without credentials. `all` (default) = everything.",
  ),
});

export interface IntegrationItem {
  id: string;
  status: "ready" | "unconnected";
  /** Credential label (typically the user-facing email/account name). Only set when status=ready. */
  label?: string;
  /** Whether this is the default credential for the provider. */
  isDefault?: boolean;
  /** URL domains that map to this provider, comma-separated. */
  urlDomains?: string;
}

export function createListIntegrationsTool(logger: Logger): AtlasTools {
  return {
    list_integrations: tool({
      description:
        "List external service integrations available in this workspace. " +
        "Returns provider ids + connection status. Use this when the user " +
        "asks 'what's connected?' or before suggesting a service-dependent " +
        "action — don't speculate about availability without checking.",
      inputSchema: ListIntegrationsInput,
      execute: async ({ status = "all" }): Promise<ReadResponse<IntegrationItem>> => {
        const summary = await fetchLinkSummary(logger);
        if (!summary) {
          return envelope({ items: [], source: "system-config", origin: "link:summary" });
        }

        const credsByProvider = new Map<string, (typeof summary.credentials)[number][]>();
        for (const cred of summary.credentials) {
          const list = credsByProvider.get(cred.provider) ?? [];
          list.push(cred);
          credsByProvider.set(cred.provider, list);
        }

        const items: IntegrationItem[] = [];
        for (const provider of summary.providers) {
          const creds = credsByProvider.get(provider.id);
          const urlDomains =
            "urlDomains" in provider && Array.isArray(provider.urlDomains)
              ? provider.urlDomains.join(",")
              : undefined;

          if (!creds || creds.length === 0) {
            if (status !== "ready") {
              items.push({ id: provider.id, status: "unconnected", urlDomains });
            }
          } else {
            if (status === "unconnected") continue;
            for (const cred of creds) {
              items.push({
                id: provider.id,
                status: "ready",
                label: cred.label,
                isDefault: cred.isDefault,
                urlDomains,
              });
            }
          }
        }

        return envelope({ items, source: "system-config", origin: "link:summary" });
      },
    }),
  };
}
