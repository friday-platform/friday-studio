import { assertEquals, assertExists } from "@std/assert";
import { createMCPClient } from "./fixtures/mcp-client.ts";

Deno.test("Agents Tools - list", async () => {
  const { client, transport } = await createMCPClient();

  try {
    // First get a workspace ID
    const workspaceResult = await client.callTool({
      name: "atlas:workspace_list",
      arguments: {},
    });

    const workspaceContent = workspaceResult.content as Array<{ type: string; text: string }>;
    const workspaceTextContent = workspaceContent.find((item) => item.type === "text");
    const workspaceData = JSON.parse(workspaceTextContent!.text);

    if (workspaceData.workspaces.length > 0) {
      const workspaceId = workspaceData.workspaces[0].id;

      const result = await client.callTool({
        name: "atlas:workspace_agents_list",
        arguments: {
          workspaceId: workspaceId,
        },
      });

      assertEquals(Array.isArray(result.content), true);

      const content = result.content as Array<{ type: string; text: string }>;
      const textContent = content.find((item) => item.type === "text");
      const responseData = JSON.parse(textContent!.text);

      // Should have agents array
      assertExists(responseData.agents);
      assertEquals(Array.isArray(responseData.agents), true);

      // Should have workspace info
      assertExists(responseData.workspace);
    }
  } finally {
    await transport.close();
  }
});

Deno.test("Agents Tools - describe", async () => {
  const { client, transport } = await createMCPClient();

  try {
    // First get a workspace and agent
    const workspaceResult = await client.callTool({
      name: "atlas:workspace_list",
      arguments: {},
    });

    const workspaceContent = workspaceResult.content as Array<{ type: string; text: string }>;
    const workspaceTextContent = workspaceContent.find((item) => item.type === "text");
    const workspaceData = JSON.parse(workspaceTextContent!.text);

    if (workspaceData.workspaces.length > 0) {
      const workspaceId = workspaceData.workspaces[0].id;

      const agentsResult = await client.callTool({
        name: "atlas:workspace_agents_list",
        arguments: { workspaceId: workspaceId },
      });

      const agentsContent = agentsResult.content as Array<{ type: string; text: string }>;
      const agentsTextContent = agentsContent.find((item) => item.type === "text");
      const agentsData = JSON.parse(agentsTextContent!.text);

      if (agentsData.agents.length > 0) {
        const agentName = agentsData.agents[0].name;

        const result = await client.callTool({
          name: "atlas:workspace_agents_describe",
          arguments: {
            workspaceId: workspaceId,
            agentId: agentName,
          },
        });

        assertEquals(Array.isArray(result.content), true);

        const content = result.content as Array<{ type: string; text: string }>;
        const textContent = content.find((item) => item.type === "text");
        const responseData = JSON.parse(textContent!.text);

        // Should have agent details
        assertExists(responseData.agent);
        assertEquals(responseData.agent.name, agentName);
        assertExists(responseData.agent.description);
      }
    }
  } finally {
    await transport.close();
  }
});
