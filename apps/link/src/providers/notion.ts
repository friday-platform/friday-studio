import { stringifyError } from "@atlas/utils";
import { Client } from "@socotra/modelcontextprotocol-sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@socotra/modelcontextprotocol-sdk/client/streamableHttp.js";
import { z } from "zod";
import { defineOAuthProvider } from "./types.ts";

/**
 * Schema for Notion's notion-get-self MCP tool response.
 * @see https://developers.notion.com/docs/mcp-supported-tools
 */
const NotionSelfResponseSchema = z.object({
  id: z.string(),
  bot: z.object({
    owner: z
      .object({
        user: z.object({ id: z.string(), person: z.object({ email: z.string() }).optional() }),
      })
      .optional(),
  }),
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
      const result = await mcpClient.callTool({ name: "notion-get-self", arguments: {} });
      const content = ToolResultContentSchema.parse(result.content);
      const textContent = content.find((c) => c.type === "text");
      if (!textContent?.text) {
        throw new Error("notion-get-self returned no text content");
      }

      const user = NotionSelfResponseSchema.parse(JSON.parse(textContent.text));

      // Return email if available, otherwise owner user id, otherwise bot id
      return user.bot.owner?.user.person?.email ?? user.bot.owner?.user.id ?? user.id;
    } finally {
      await mcpClient.close();
    }
  },
});
