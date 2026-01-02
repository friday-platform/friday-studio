import { stringifyError } from "@atlas/utils";
import { Client } from "@socotra/modelcontextprotocol-sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@socotra/modelcontextprotocol-sdk/client/streamableHttp.js";
import { z } from "zod";
import { defineOAuthProvider } from "./types.ts";

const MCP_URL = "https://mcp.atlassian.com/v1/mcp";

/**
 * Schema for Atlassian /me endpoint response.
 * @see https://developer.atlassian.com/cloud/confluence/rest/v1/api-group-users/#api-wiki-rest-api-user-current-get
 */
const AtlassianMeSchema = z.object({
  account_id: z.string(),
  email: z.string().optional(),
  name: z.string().optional(),
});

async function createMcpClient(accessToken: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  const client = new Client({ name: "atlas-link", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

export const atlassianProvider = defineOAuthProvider({
  id: "atlassian",
  displayName: "Atlassian – Jira & Confluence",
  description: "Jira and Confluence access via MCP",
  oauthConfig: { mode: "discovery", serverUrl: MCP_URL },
  health: async (tokens) => {
    const mcpClient = await createMcpClient(tokens.access_token);
    try {
      await mcpClient.listTools();
      return { healthy: true };
    } catch (e) {
      return { healthy: false, error: stringifyError(e) };
    }
  },
  identify: async (tokens) => {
    // Atlassian MCP has no get_self tool - use REST API
    const res = await fetch("https://api.atlassian.com/me", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (!res.ok) {
      throw new Error(`Atlassian /me failed: ${res.status}`);
    }
    const data = AtlassianMeSchema.parse(await res.json());
    return data.account_id; // Immutable account ID
  },
});
