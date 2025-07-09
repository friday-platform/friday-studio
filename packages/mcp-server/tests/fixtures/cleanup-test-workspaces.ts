import { createMCPClient } from "./mcp-client.ts";

export async function cleanupTestWorkspaces() {
  const { client, transport } = await createMCPClient();

  try {
    // Get all workspaces
    const result = await client.callTool({
      name: "atlas_workspace_list",
      arguments: {},
    });

    const content = result.content as Array<{ type: string; text: string }>;
    const textContent = content.find((item) => item.type === "text");
    const data = JSON.parse(textContent!.text);

    // Find test workspaces
    const testWorkspaces = data.workspaces.filter((ws: { name: string }) =>
      ws.name.includes("test-workspace") || ws.name.includes("test-delete-workspace")
    );

    console.log(`Found ${testWorkspaces.length} test workspaces to clean up`);

    // Delete each test workspace
    for (const workspace of testWorkspaces) {
      try {
        await client.callTool({
          name: "atlas_workspace_delete",
          arguments: {
            workspaceId: workspace.id,
          },
        });
        console.log(`✅ Deleted workspace: ${workspace.name} (${workspace.id})`);
      } catch (error) {
        console.warn(`❌ Failed to delete workspace ${workspace.name}:`, error);
      }
    }
  } finally {
    await transport.close();
  }
}

// Run cleanup if this file is executed directly
if (import.meta.main) {
  await cleanupTestWorkspaces();
}
