import type { AtlasTools } from "@atlas/agent-sdk";
import { mcpServersRegistry } from "@atlas/core/mcp-registry/registry-consolidated";
import type { Logger } from "@atlas/logger";
import { tool } from "ai";
import { z } from "zod";
import { fetchLinkSummary } from "../../link-context.ts";

const ListIntegrationsInput = z.object({});

const DescribeIntegrationInput = z.object({
  provider: z
    .string()
    .min(1)
    .describe(
      "Provider id (e.g. 'gmail', 'slack', 'notion'). Use list_integrations to discover " +
        "valid provider ids if you don't already know one.",
    ),
});

interface IntegrationCredential {
  label: string;
  isDefault?: boolean;
}

export interface IntegrationEntry {
  provider: string;
  status: "ready" | "unconnected";
  urlDomains: string[];
  credentials: IntegrationCredential[];
}

export interface ListIntegrationsSuccess {
  ok: true;
  integrations: IntegrationEntry[];
  count: number;
}

export interface DescribeIntegrationSuccess {
  ok: true;
  integration: IntegrationEntry;
}

export interface IntegrationToolError {
  ok: false;
  error: string;
}

interface SummaryProvider {
  id: string;
}

interface SummaryCredential {
  provider: string;
  label: string;
  isDefault?: boolean;
}

interface LinkSummary {
  providers: SummaryProvider[];
  credentials: SummaryCredential[];
}

function buildEntries(summary: LinkSummary): IntegrationEntry[] {
  const credsByProvider = new Map<string, IntegrationCredential[]>();
  for (const cred of summary.credentials) {
    const list = credsByProvider.get(cred.provider) ?? [];
    list.push({ label: cred.label, ...(cred.isDefault ? { isDefault: true } : {}) });
    credsByProvider.set(cred.provider, list);
  }
  const entries: IntegrationEntry[] = [];
  for (const provider of summary.providers) {
    const mcpEntry = mcpServersRegistry.servers[provider.id];
    const urlDomains = mcpEntry?.urlDomains ? [...mcpEntry.urlDomains] : [];
    const creds = credsByProvider.get(provider.id) ?? [];
    entries.push({
      provider: provider.id,
      status: creds.length > 0 ? "ready" : "unconnected",
      urlDomains,
      credentials: creds,
    });
  }
  return entries.sort((a, b) => a.provider.localeCompare(b.provider));
}

/**
 * Build the `list_integrations` tool for workspace chat.
 *
 * Replaces the inline `<integrations>` block. Each integration mutates at
 * session frequency during connect flows (every successful `connect_service`
 * flips a status), which busts the 1h workspace-stable cache for every
 * other byte in block 2. Pulling integrations on demand keeps that section
 * out of the cache prefix.
 */
export function createListIntegrationsTool(logger: Logger): AtlasTools {
  return {
    list_integrations: tool({
      description:
        "List every Link-managed service the user could connect, with the current connection " +
        "status (`ready` or `unconnected`) and the URL domains the provider serves. Use this " +
        "before deciding whether to call `connect_service` (status=unconnected) or " +
        "`enable_mcp_server` (status=ready). Per-user — connection state isn't workspace-scoped.",
      inputSchema: ListIntegrationsInput,
      execute: async (): Promise<ListIntegrationsSuccess | IntegrationToolError> => {
        const summary = await fetchLinkSummary(logger);
        if (!summary) {
          logger.warn("list_integrations: link summary unavailable");
          return {
            ok: false,
            error:
              "Link service is unavailable — no integration data. The daemon may still be " +
              "starting, or the Link credential database is unreachable.",
          };
        }
        const integrations = buildEntries(summary);
        logger.info("list_integrations succeeded", { count: integrations.length });
        return { ok: true, integrations, count: integrations.length };
      },
    }),
  };
}

/**
 * Build the `describe_integration` tool for workspace chat.
 *
 * Returns the single integration entry for a provider id — same shape as
 * `list_integrations` but scoped to one provider for cheaper "is X
 * connected?" checks. Fails with ok:false when the provider isn't in the
 * Link summary at all (typo or missing MCP-registry entry).
 */
export function createDescribeIntegrationTool(logger: Logger): AtlasTools {
  return {
    describe_integration: tool({
      description:
        "Return the connection status, label(s), and URL domains for a single Link provider. " +
        "Cheaper than list_integrations when you already know which provider you're asking " +
        "about — call this for 'is my Gmail connected?' / 'what's my Slack workspace label?' " +
        "questions. Fails with ok:false if the provider id isn't in the Link summary.",
      inputSchema: DescribeIntegrationInput,
      execute: async ({ provider }): Promise<DescribeIntegrationSuccess | IntegrationToolError> => {
        const summary = await fetchLinkSummary(logger);
        if (!summary) {
          return {
            ok: false,
            error:
              "Link service is unavailable — no integration data. The daemon may still be " +
              "starting, or the Link credential database is unreachable.",
          };
        }
        const integrations = buildEntries(summary);
        const match = integrations.find((i) => i.provider === provider);
        if (!match) {
          return {
            ok: false,
            error: `Provider "${provider}" not found. Use list_integrations to see valid provider ids.`,
          };
        }
        logger.info("describe_integration succeeded", { provider, status: match.status });
        return { ok: true, integration: match };
      },
    }),
  };
}
