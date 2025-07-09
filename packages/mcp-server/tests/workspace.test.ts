import { assertEquals, assertExists } from "@std/assert";
import { createMCPClient } from "./fixtures/mcp-client.ts";

Deno.test("Workspace Tools - list", async () => {
  const { client, transport } = await createMCPClient();

  try {
    const result = await client.callTool({
      name: "atlas_workspace_list",
      arguments: {},
    });

    assertEquals(Array.isArray(result.content), true);

    const content = result.content as Array<{ type: string; text: string }>;
    const textContent = content.find((item) => item.type === "text");
    const responseData = JSON.parse(textContent!.text);

    // Should have workspaces array
    assertExists(responseData.workspaces);
    assertEquals(Array.isArray(responseData.workspaces), true);

    // Should have total count
    assertExists(responseData.total);
    assertEquals(typeof responseData.total, "number");
  } finally {
    await transport.close();
  }
});

Deno.test("Workspace Tools - describe", async () => {
  const { client, transport } = await createMCPClient();

  try {
    // First get a workspace to describe
    const listResult = await client.callTool({
      name: "atlas_workspace_list",
      arguments: {},
    });

    const listContent = listResult.content as Array<{ type: string; text: string }>;
    const listTextContent = listContent.find((item) => item.type === "text");
    const listData = JSON.parse(listTextContent!.text);

    if (listData.workspaces.length > 0) {
      const workspaceId = listData.workspaces[0].id;

      const result = await client.callTool({
        name: "atlas_workspace_describe",
        arguments: {
          workspaceId: workspaceId,
        },
      });

      assertEquals(Array.isArray(result.content), true);

      const content = result.content as Array<{ type: string; text: string }>;
      const textContent = content.find((item) => item.type === "text");
      const responseData = JSON.parse(textContent!.text);

      // Should have workspace details
      assertExists(responseData.id);
      assertEquals(responseData.id, workspaceId);
      assertExists(responseData.name);
      assertExists(responseData.config);
    }
  } finally {
    await transport.close();
  }
});

Deno.test("Workspace Tools - create", async () => {
  const { client, transport } = await createMCPClient();
  let createdWorkspaceId: string | undefined;

  try {
    const testWorkspaceName = `test-workspace-${Date.now()}`;
    const testPath = await Deno.makeTempDir({ prefix: "atlas_workspace_test_" });

    try {
      const result = await client.callTool({
        name: "atlas_workspace_create",
        arguments: {
          name: testWorkspaceName,
          path: testPath,
          description: "Test workspace for MCP tests",
        },
      });

      assertEquals(Array.isArray(result.content), true);

      const content = result.content as Array<{ type: string; text: string }>;
      const textContent = content.find((item) => item.type === "text");
      const responseData = JSON.parse(textContent!.text);

      // Should have created workspace info
      assertExists(responseData.id);
      assertEquals(responseData.name, testWorkspaceName);
      assertExists(responseData.path);
      assertEquals(responseData.status, "stopped");

      // Store workspace ID for cleanup
      createdWorkspaceId = responseData.id;
    } finally {
      await Deno.remove(testPath, { recursive: true });
    }
  } finally {
    // Clean up created workspace
    if (createdWorkspaceId) {
      try {
        await client.callTool({
          name: "atlas_workspace_delete",
          arguments: {
            workspaceId: createdWorkspaceId,
          },
        });
      } catch (error) {
        console.warn(`Failed to clean up workspace ${createdWorkspaceId}:`, error);
      }
    }
    await transport.close();
  }
});

Deno.test("Workspace Tools - delete", async () => {
  const { client, transport } = await createMCPClient();
  let createdWorkspaceId: string | undefined;

  try {
    // First create a workspace to delete
    const testWorkspaceName = `test-delete-workspace-${Date.now()}`;
    const testPath = await Deno.makeTempDir({ prefix: "atlas_workspace_delete_test_" });

    try {
      const createResult = await client.callTool({
        name: "atlas_workspace_create",
        arguments: {
          name: testWorkspaceName,
          path: testPath,
          description: "Test workspace for deletion",
        },
      });

      const createContent = createResult.content as Array<{ type: string; text: string }>;
      const createTextContent = createContent.find((item) => item.type === "text");
      const createData = JSON.parse(createTextContent!.text);

      const workspaceId = createData.id;
      createdWorkspaceId = workspaceId;

      // Now delete the workspace
      const deleteResult = await client.callTool({
        name: "atlas_workspace_delete",
        arguments: {
          workspaceId: workspaceId,
        },
      });

      assertEquals(Array.isArray(deleteResult.content), true);

      const deleteContent = deleteResult.content as Array<{ type: string; text: string }>;
      const deleteTextContent = deleteContent.find((item) => item.type === "text");
      const deleteData = JSON.parse(deleteTextContent!.text);

      // Should confirm deletion
      assertExists(deleteData.deleted);
      assertEquals(deleteData.workspaceId, workspaceId);

      // Mark as successfully deleted
      createdWorkspaceId = undefined;
    } finally {
      await Deno.remove(testPath, { recursive: true });
    }
  } finally {
    // Clean up workspace if deletion test failed
    if (createdWorkspaceId) {
      try {
        await client.callTool({
          name: "atlas_workspace_delete",
          arguments: {
            workspaceId: createdWorkspaceId,
          },
        });
      } catch (error) {
        console.warn(`Failed to clean up workspace ${createdWorkspaceId}:`, error);
      }
    }
    await transport.close();
  }
});
