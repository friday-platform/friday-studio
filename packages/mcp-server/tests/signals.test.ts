import { assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createMCPClient } from "./fixtures/mcp-client.ts";

Deno.test("Signals Tools - list", async () => {
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
        name: "atlas:workspace_signals_list",
        arguments: {
          workspaceId: workspaceId,
        },
      });

      assertEquals(Array.isArray(result.content), true);

      const content = result.content as Array<{ type: string; text: string }>;
      const textContent = content.find((item) => item.type === "text");
      const responseData = JSON.parse(textContent!.text);

      // Should have signals array
      assertExists(responseData.signals);
      assertEquals(Array.isArray(responseData.signals), true);

      // Should have workspace info
      assertExists(responseData.workspace);
    }
  } finally {
    await transport.close();
  }
});

Deno.test("Signals Tools - trigger", async () => {
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
        name: "atlas:workspace_signals_trigger",
        arguments: {
          workspaceId: workspaceId,
          signalName: "test-signal",
          payload: { test: "data" },
        },
      });

      assertEquals(Array.isArray(result.content), true);

      const content = result.content as Array<{ type: string; text: string }>;
      const textContent = content.find((item) => item.type === "text");
      const responseData = JSON.parse(textContent!.text);

      // Should have trigger result
      assertExists(responseData);
    }
  } finally {
    await transport.close();
  }
});
