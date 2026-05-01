import { stringifyError } from "@atlas/utils";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { defineOAuthProvider } from "./types.ts";

const MCP_URL = "https://mcp.atlassian.com/v1/mcp";

/**
 * Schema for atlassianUserInfo tool response.
 * @see https://support.atlassian.com/atlassian-rovo-mcp-server/docs/supported-tools/
 */
const AtlassianUserInfoSchema = z.object({
  account_id: z.string(),
  email: z.string().optional(),
  name: z.string().optional(),
  picture: z.string().optional(),
});

/** Schema for MCP tool result content */
const ToolResultContentSchema = z.array(
  z.object({ type: z.string(), text: z.string().optional() }),
);

/**
 * Create MCP client for Atlassian
 */
async function createMcpClient(accessToken: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  const client = new Client({ name: "friday", version: "1.0.0" }, { capabilities: {} });
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
    } finally {
      await mcpClient.close();
    }
  },
  identify: async (tokens) => {
    // Use the official atlassianUserInfo MCP tool to get user identity
    // @see https://support.atlassian.com/atlassian-rovo-mcp-server/docs/supported-tools/
    const mcpClient = await createMcpClient(tokens.access_token);
    try {
      const result = await mcpClient.callTool({ name: "atlassianUserInfo", arguments: {} });
      const content = ToolResultContentSchema.parse(result.content);
      const textContent = content.find((c) => c.type === "text");
      if (!textContent?.text) {
        throw new Error("atlassianUserInfo returned no text content");
      }
      const userInfo = AtlassianUserInfoSchema.parse(JSON.parse(textContent.text));
      return userInfo.email ?? userInfo.account_id;
    } finally {
      await mcpClient.close();
    }
  },
});
