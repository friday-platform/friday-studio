import { stringifyError } from "@atlas/utils";
import { Client } from "@socotra/modelcontextprotocol-sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@socotra/modelcontextprotocol-sdk/client/streamableHttp.js";
import { z } from "zod";
import { defineOAuthProvider } from "./types.ts";

const MCP_URL = "https://mcp.linear.app/mcp";

/**
 * Schema for Linear get_user MCP tool response.
 * @see https://linear.app/docs/mcp
 */
const LinearUserResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().optional(),
});

/** Schema for MCP tool result content */
const ToolResultContentSchema = z.array(
  z.object({ type: z.string(), text: z.string().optional() }),
);

async function createMcpClient(accessToken: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  const client = new Client({ name: "atlas-link", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

export const linearProvider = defineOAuthProvider({
  id: "linear",
  displayName: "Linear",
  description: "Linear project management via MCP",
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
    const mcpClient = await createMcpClient(tokens.access_token);
    try {
      const result = await mcpClient.callTool({ name: "get_user", arguments: { query: "me" } });
      const content = ToolResultContentSchema.parse(result.content);
      const textContent = content.find((c) => c.type === "text");
      if (!textContent?.text) {
        throw new Error("get_user returned no text content");
      }
      const user = LinearUserResponseSchema.parse(JSON.parse(textContent.text));
      return user.id;
    } finally {
      await mcpClient.close();
    }
  },
});
