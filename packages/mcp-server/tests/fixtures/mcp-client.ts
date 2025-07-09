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

// Helper to delete workspace safely
export async function deleteWorkspace(client: Client, workspaceId: string) {
  try {
    await client.callTool({
      name: "atlas_workspace_delete",
      arguments: { workspaceId },
    });
  } catch (error) {
    console.warn(`Failed to delete workspace ${workspaceId}:`, error);
  }
}

// Helper to delete draft safely
export async function deleteDraft(client: Client, draftId: string) {
  try {
    await client.callTool({
      name: "atlas_drafts_delete",
      arguments: { id: draftId },
    });
  } catch (error) {
    console.warn(`Failed to delete draft ${draftId}:`, error);
  }
}
