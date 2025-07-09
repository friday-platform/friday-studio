import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const MCP_ENDPOINT = "http://localhost:8080/mcp";

export async function createMCPClient() {
  const client = new Client({
    name: "atlas-test-client",
    version: "1.0.0",
  });

  const transport = new StreamableHTTPClientTransport(
    new URL(MCP_ENDPOINT),
  );

  await client.connect(transport);

  return { client, transport };
}
