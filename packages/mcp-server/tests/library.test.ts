import { assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createMCPClient } from "./fixtures/mcp-client.ts";

Deno.test("Library Tools - list", async () => {
  const { client, transport } = await createMCPClient();

  try {
    const result = await client.callTool({
      name: "atlas:library_list",
      arguments: {
        limit: 10,
      },
    });

    assertEquals(Array.isArray(result.content), true);

    const content = result.content as Array<{ type: string; text: string }>;
    const textContent = content.find((item) => item.type === "text");
    const responseData = JSON.parse(textContent!.text);

    // Should have items array
    assertExists(responseData.items);
    assertEquals(Array.isArray(responseData.items), true);

    // Should have total count
    assertExists(responseData.total);
    assertEquals(typeof responseData.total, "number");

    // Should have query info
    assertExists(responseData.query);
    assertEquals(typeof responseData.query.limit, "number");
  } finally {
    await transport.close();
  }
});

Deno.test("Library Tools - get", async () => {
  const { client, transport } = await createMCPClient();

  try {
    // First list items to get an ID
    const listResult = await client.callTool({
      name: "atlas:library_list",
      arguments: { limit: 1 },
    });

    const listContent = listResult.content as Array<{ type: string; text: string }>;
    const listTextContent = listContent.find((item) => item.type === "text");
    const listData = JSON.parse(listTextContent!.text);

    if (listData.items.length > 0) {
      const itemId = listData.items[0].id;

      const result = await client.callTool({
        name: "atlas:library_get",
        arguments: {
          itemId: itemId,
        },
      });

      assertEquals(Array.isArray(result.content), true);

      const content = result.content as Array<{ type: string; text: string }>;
      const textContent = content.find((item) => item.type === "text");
      const responseData = JSON.parse(textContent!.text);

      // Should have item details
      assertExists(responseData.item);
      assertEquals(responseData.item.id, itemId);
      assertExists(responseData.item.name);
      assertExists(responseData.item.type);
    } else {
      // If no items, that's okay - just verify we can call the tool
      assertEquals(listData.items.length, 0);
    }
  } finally {
    await transport.close();
  }
});

Deno.test("Library Tools - stats", async () => {
  const { client, transport } = await createMCPClient();

  try {
    const result = await client.callTool({
      name: "atlas:library_stats",
      arguments: {},
    });

    assertEquals(Array.isArray(result.content), true);

    const content = result.content as Array<{ type: string; text: string }>;
    const textContent = content.find((item) => item.type === "text");
    const responseData = JSON.parse(textContent!.text);

    // Should have statistics (basic structure)
    assertExists(responseData);
    assertEquals(typeof responseData, "object");
  } finally {
    await transport.close();
  }
});

Deno.test("Library Tools - store", async () => {
  const { client, transport } = await createMCPClient();

  try {
    const testContent = "This is test content for the library";

    const result = await client.callTool({
      name: "atlas:library_store",
      arguments: {
        name: `test-item-${Date.now()}`,
        content: testContent,
        type: "artifact",
        description: "Test library item",
        tags: ["test", "mcp"],
      },
    });

    assertEquals(Array.isArray(result.content), true);

    const content = result.content as Array<{ type: string; text: string }>;
    const textContent = content.find((item) => item.type === "text");
    const responseData = JSON.parse(textContent!.text);

    // Should have stored item info
    assertExists(responseData);
    assertEquals(typeof responseData, "object");
  } finally {
    await transport.close();
  }
});

Deno.test("Library Tools - templates", async () => {
  const { client, transport } = await createMCPClient();

  try {
    const result = await client.callTool({
      name: "atlas:library_templates",
      arguments: {},
    });

    assertEquals(Array.isArray(result.content), true);

    const content = result.content as Array<{ type: string; text: string }>;
    const textContent = content.find((item) => item.type === "text");
    const responseData = JSON.parse(textContent!.text);

    // Should have templates response
    assertExists(responseData);
    assertEquals(typeof responseData, "object");
  } finally {
    await transport.close();
  }
});
