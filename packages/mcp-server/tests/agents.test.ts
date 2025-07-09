import { assertEquals, assertExists } from "@std/assert";
import { createMCPClient } from "./fixtures/mcp-client.ts";

Deno.test({
  name: "Agents Tools - list",
  sanitizeResources: false, // Disable due to MCP SDK StreamableHTTPClientTransport bug
  fn: async () => {
    let createdWorkspaceId: string | undefined;
    let testPath: string | undefined;

    try {
      // Create a test workspace using first client
      const testWorkspaceName = `test-agents-workspace-${Date.now()}`;
      testPath = await Deno.makeTempDir({
        prefix: "atlas_agents_test_",
      });

      // Use separate client for workspace creation
      const { client: createClient, transport: createTransport } = await createMCPClient();

      try {
        const createResult = await createClient.callTool({
          name: "atlas_workspace_create",
          arguments: {
            name: testWorkspaceName,
            path: testPath,
            description: "Test workspace for agents tests",
          },
        });

        const createContent = createResult.content as Array<{ type: string; text: string }>;
        const createTextContent = createContent.find((item) => item.type === "text");
        const createData = JSON.parse(createTextContent!.text);

        createdWorkspaceId = createData.workspace.id;
      } finally {
        await createTransport.close();
      }

      // Use separate client for agents list
      const { client: listClient, transport: listTransport } = await createMCPClient();

      try {
        const result = await listClient.callTool({
          name: "atlas_workspace_agents_list",
          arguments: {
            workspaceId: createdWorkspaceId,
          },
        });

        assertEquals(Array.isArray(result.content), true);

        const content = result.content as Array<{ type: string; text: string }>;
        const textContent = content.find((item) => item.type === "text");
        const responseData = JSON.parse(textContent!.text);

        // Should have agents array
        assertExists(responseData.agents);
        assertEquals(Array.isArray(responseData.agents), true);

        // Should have total count
        assertExists(responseData.total);
        assertEquals(typeof responseData.total, "number");

        // Should have workspace ID
        assertExists(responseData.workspaceId);
        assertEquals(responseData.workspaceId, createdWorkspaceId);

        // Should have source
        assertExists(responseData.source);
        assertEquals(responseData.source, "daemon_api");
      } finally {
        await listTransport.close();
      }
    } finally {
      // Clean up workspace using third client
      if (createdWorkspaceId) {
        const { client: deleteClient, transport: deleteTransport } = await createMCPClient();
        try {
          await deleteClient.callTool({
            name: "atlas_workspace_delete",
            arguments: {
              workspaceId: createdWorkspaceId,
              force: true,
            },
          });
        } catch (error) {
          console.warn(`Failed to clean up workspace: ${error}`);
        } finally {
          await deleteTransport.close();
        }
      }

      // Clean up temp directory
      if (testPath) {
        try {
          await Deno.remove(testPath, { recursive: true });
        } catch (error) {
          console.warn(`Failed to remove test path: ${error}`);
        }
      }
    }
  },
});

Deno.test("Agents Tools - describe", async () => {
  const { client, transport } = await createMCPClient();

  try {
    // Test with a known workspace and agent ID
    // Using the atlas-conversation workspace from the example
    const mockWorkspaceId = "atlas-conversation";
    const mockAgentId = "conversation-agent";

    const result = await client.callTool({
      name: "atlas_workspace_agents_describe",
      arguments: {
        workspaceId: mockWorkspaceId,
        agentId: mockAgentId,
      },
    });

    assertEquals(Array.isArray(result.content), true);

    const content = result.content as Array<{ type: string; text: string }>;
    const textContent = content.find((item) => item.type === "text");

    // Handle case where workspace or agent doesn't exist
    if (textContent!.text.includes("not found") || textContent!.text.includes("disabled")) {
      // Expected for non-existent workspace/agent
      assertExists(textContent);
      assertExists(textContent.text);
      return;
    }

    const responseData = JSON.parse(textContent!.text);

    // Should have agent details based on the provided example
    assertExists(responseData.agent);
    assertExists(responseData.agent.type);
    assertExists(responseData.agent.agent);
    assertExists(responseData.agent.purpose);
    assertExists(responseData.workspaceId);
    assertEquals(responseData.workspaceId, mockWorkspaceId);
    assertEquals(responseData.source, "daemon_api");
  } finally {
    await transport.close();
  }
});
