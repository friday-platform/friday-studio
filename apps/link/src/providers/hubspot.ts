import { readFileSync } from "node:fs";
import { env } from "node:process";
import { stringifyError } from "@atlas/utils";
import { Client } from "@socotra/modelcontextprotocol-sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@socotra/modelcontextprotocol-sdk/client/streamableHttp.js";
import { z } from "zod";
import { defineOAuthProvider, type OAuthProvider } from "./types.ts";

const MCP_URL = "https://mcp.hubspot.com";

/** Schema for HubSpot OAuth token info response */
const HubSpotTokenInfoSchema = z.object({
  user_id: z.number(),
  hub_id: z.number(),
  user: z.string().optional(),
});

async function createMcpClient(accessToken: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  const client = new Client({ name: "friday", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

/**
 * Creates HubSpot OAuth provider.
 * HubSpot MCP does not support dynamic client registration, so we use static mode.
 * Reads client credentials from files specified by env vars.
 *
 * @returns OAuthProvider if HUBSPOT_CLIENT_ID_FILE and HUBSPOT_CLIENT_SECRET_FILE are set, undefined otherwise
 */
export function createHubSpotProvider(): OAuthProvider | undefined {
  const clientIdFile = env.HUBSPOT_CLIENT_ID_FILE;
  const clientSecretFile = env.HUBSPOT_CLIENT_SECRET_FILE;

  if (!clientIdFile || !clientSecretFile) {
    return undefined;
  }

  const clientId = readFileSync(clientIdFile, "utf-8").trim();
  const clientSecret = readFileSync(clientSecretFile, "utf-8").trim();

  return defineOAuthProvider({
    id: "hubspot",
    displayName: "HubSpot",
    description: "HubSpot CRM access via MCP",
    oauthConfig: {
      mode: "static",
      authorizationEndpoint: "https://app.hubspot.com/oauth/authorize",
      tokenEndpoint: "https://api.hubapi.com/oauth/v1/token",
      clientId,
      clientSecret,
      scopes: [
        "oauth",
        "crm.objects.tickets.read", // required by HubSpot MCP
        "crm.objects.contacts.read",
        "crm.objects.companies.read",
        "crm.objects.deals.read",
      ],
    },
    health: async (tokens) => {
      const mcpClient = await createMcpClient(tokens.access_token);
      try {
        await mcpClient.listTools();
        return { healthy: true };
      } catch (e) {
        return { healthy: false, error: stringifyError(e) };
      } finally {
        await mcpClient.close();
      }
    },
    identify: async (tokens) => {
      // HubSpot MCP has no get_self tool - use REST API
      const res = await fetch(
        `https://api.hubapi.com/oauth/v1/access-tokens/${tokens.access_token}`,
      );
      if (!res.ok) {
        throw new Error(`HubSpot token info failed: ${res.status}`);
      }
      const data = HubSpotTokenInfoSchema.parse(await res.json());
      return String(data.user_id); // Immutable user ID
    },
  });
}
