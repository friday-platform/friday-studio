import { stringifyError } from "@atlas/utils";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { defineOAuthProvider } from "./types.ts";

const MCP_URL = "https://mcp.sentry.dev/mcp";

/** Schema for MCP tool result content */
const ToolResultContentSchema = z.array(
  z.object({ type: z.string(), text: z.string().optional() }),
);

/**
 * Extract email from whoami tool response text.
 * The whoami tool returns: "You are authenticated as Name (email).\n\nYour Sentry User ID is 12345."
 */
function extractEmailFromWhoami(text: string): string {
  const match = text.match(/You are authenticated as .+? \(([^)]+)\)/);
  if (!match?.[1]) {
    throw new Error(`Could not extract email from whoami response: ${text}`);
  }
  return match[1];
}

async function createMcpClient(accessToken: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  const client = new Client({ name: "friday", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

export const sentryProvider = defineOAuthProvider({
  id: "sentry",
  displayName: "Sentry",
  description: "Sentry error tracking via MCP",
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
    // Use MCP whoami tool - REST API tokens don't work with MCP OAuth discovery tokens
    const mcpClient = await createMcpClient(tokens.access_token);
    try {
      const result = await mcpClient.callTool({ name: "whoami", arguments: {} });
      const content = ToolResultContentSchema.parse(result.content);
      const textContent = content.find((c) => c.type === "text");
      if (!textContent?.text) {
        throw new Error("whoami returned no text content");
      }
      return extractEmailFromWhoami(textContent.text);
    } finally {
      await mcpClient.close();
    }
  },
});
