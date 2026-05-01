import { stringifyError } from "@atlas/utils";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { defineOAuthProvider } from "./types.ts";

/**
 * Schema for Notion's notion-get-users MCP tool response (with user_id: "self").
 * @see https://developers.notion.com/docs/mcp-supported-tools
 */
const NotionUsersResponseSchema = z.object({
  results: z.array(
    z.object({ type: z.string(), id: z.string(), name: z.string().optional(), email: z.string() }),
  ),
  has_more: z.boolean(),
});

/** Schema for MCP tool result content */
const ToolResultContentSchema = z.array(
  z.object({ type: z.string(), text: z.string().optional() }),
);

async function createMcpClient(accessToken: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL("https://mcp.notion.com/mcp"), {
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  const client = new Client({ name: "friday", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

export const notionProvider = defineOAuthProvider({
  id: "notion",
  displayName: "Notion",
  description: "Notion workspace access via MCP",
  oauthConfig: { mode: "discovery", serverUrl: "https://mcp.notion.com/mcp" },
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
    const mcpClient = await createMcpClient(tokens.access_token);
    try {
      const result = await mcpClient.callTool({
        name: "notion-get-users",
        arguments: { user_id: "self" },
      });
      const content = ToolResultContentSchema.parse(result.content);
      const textContent = content.find((c) => c.type === "text");
      if (!textContent?.text) {
        throw new Error("notion-get-users returned no text content");
      }

      const response = NotionUsersResponseSchema.parse(JSON.parse(textContent.text));
      const user = response.results[0];
      if (!user) {
        throw new Error("notion-get-users returned empty results");
      }

      return user.email;
    } finally {
      await mcpClient.close();
    }
  },
});
