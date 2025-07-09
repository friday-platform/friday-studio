import { assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createMCPClient } from "./fixtures/mcp-client.ts";

Deno.test("Drafts Tools - list", async () => {
  const { client, transport } = await createMCPClient();

  try {
    const result = await client.callTool({
      name: "atlas:drafts_list",
      arguments: {},
    });

    assertEquals(Array.isArray(result.content), true);

    const content = result.content as Array<{ type: string; text: string }>;
    const textContent = content.find((item) => item.type === "text");
    const responseData = JSON.parse(textContent!.text);

    // Should have drafts array
    assertExists(responseData.drafts);
    assertEquals(Array.isArray(responseData.drafts), true);

    // Should have metadata
    assertExists(responseData.metadata);
    assertEquals(typeof responseData.metadata.total, "number");
  } finally {
    await transport.close();
  }
});

Deno.test("Drafts Tools - create", async () => {
  const { client, transport } = await createMCPClient();
  let createdDraftId: string | undefined;

  try {
    const testDraft = {
      name: `test-draft-${Date.now()}`,
      content: "This is a test draft",
      type: "artifact",
      description: "Test draft for MCP tests",
    };

    const result = await client.callTool({
      name: "atlas:drafts_create",
      arguments: testDraft,
    });

    assertEquals(Array.isArray(result.content), true);

    const content = result.content as Array<{ type: string; text: string }>;
    const textContent = content.find((item) => item.type === "text");
    const responseData = JSON.parse(textContent!.text);

    // Should have created draft info
    assertExists(responseData.draft);
    assertEquals(responseData.draft.name, testDraft.name);
    assertExists(responseData.draft.id);
    assertEquals(responseData.created, true);

    // Store draft ID for cleanup
    createdDraftId = responseData.draft.id;
  } finally {
    // Clean up created draft
    if (createdDraftId) {
      try {
        await client.callTool({
          name: "atlas:drafts_delete",
          arguments: {
            id: createdDraftId,
          },
        });
      } catch (error) {
        console.warn(`Failed to clean up draft ${createdDraftId}:`, error);
      }
    }
    await transport.close();
  }
});

Deno.test("Drafts Tools - show", async () => {
  const { client, transport } = await createMCPClient();

  try {
    // First list drafts to get an ID
    const listResult = await client.callTool({
      name: "atlas:drafts_list",
      arguments: {},
    });

    const listContent = listResult.content as Array<{ type: string; text: string }>;
    const listTextContent = listContent.find((item) => item.type === "text");
    const listData = JSON.parse(listTextContent!.text);

    if (listData.drafts.length > 0) {
      const draftId = listData.drafts[0].id;

      const result = await client.callTool({
        name: "atlas:drafts_show",
        arguments: {
          id: draftId,
        },
      });

      assertEquals(Array.isArray(result.content), true);

      const content = result.content as Array<{ type: string; text: string }>;
      const textContent = content.find((item) => item.type === "text");
      const responseData = JSON.parse(textContent!.text);

      // Should have draft details
      assertExists(responseData.draft);
      assertEquals(responseData.draft.id, draftId);
      assertExists(responseData.draft.content);
    }
  } finally {
    await transport.close();
  }
});

Deno.test("Drafts Tools - update", async () => {
  const { client, transport } = await createMCPClient();
  let createdDraftId: string | undefined;

  try {
    // First create a draft
    const createResult = await client.callTool({
      name: "atlas:drafts_create",
      arguments: {
        name: `test-update-draft-${Date.now()}`,
        content: "Original content",
        type: "artifact",
      },
    });

    const createContent = createResult.content as Array<{ type: string; text: string }>;
    const createTextContent = createContent.find((item) => item.type === "text");
    const createData = JSON.parse(createTextContent!.text);

    const draftId = createData.draft.id;
    createdDraftId = draftId;

    // Now update it
    const result = await client.callTool({
      name: "atlas:drafts_update",
      arguments: {
        id: draftId,
        content: "Updated content",
        description: "Updated description",
      },
    });

    assertEquals(Array.isArray(result.content), true);

    const content = result.content as Array<{ type: string; text: string }>;
    const textContent = content.find((item) => item.type === "text");
    const responseData = JSON.parse(textContent!.text);

    // Should have updated draft info
    assertExists(responseData.draft);
    assertEquals(responseData.draft.id, draftId);
    assertEquals(responseData.updated, true);
  } finally {
    // Clean up created draft
    if (createdDraftId) {
      try {
        await client.callTool({
          name: "atlas:drafts_delete",
          arguments: {
            id: createdDraftId,
          },
        });
      } catch (error) {
        console.warn(`Failed to clean up draft ${createdDraftId}:`, error);
      }
    }
    await transport.close();
  }
});

Deno.test("Drafts Tools - validate", async () => {
  const { client, transport } = await createMCPClient();

  try {
    // First list drafts to get an ID
    const listResult = await client.callTool({
      name: "atlas:drafts_list",
      arguments: {},
    });

    const listContent = listResult.content as Array<{ type: string; text: string }>;
    const listTextContent = listContent.find((item) => item.type === "text");
    const listData = JSON.parse(listTextContent!.text);

    if (listData.drafts.length > 0) {
      const draftId = listData.drafts[0].id;

      const result = await client.callTool({
        name: "atlas:drafts_validate",
        arguments: {
          id: draftId,
        },
      });

      assertEquals(Array.isArray(result.content), true);

      const content = result.content as Array<{ type: string; text: string }>;
      const textContent = content.find((item) => item.type === "text");
      const responseData = JSON.parse(textContent!.text);

      // Should have validation result
      assertExists(responseData.validation);
      assertEquals(typeof responseData.validation.valid, "boolean");
    }
  } finally {
    await transport.close();
  }
});

Deno.test("Drafts Tools - publish", async () => {
  const { client, transport } = await createMCPClient();
  let createdDraftId: string | undefined;

  try {
    // First create a draft
    const createResult = await client.callTool({
      name: "atlas:drafts_create",
      arguments: {
        name: `test-publish-draft-${Date.now()}`,
        content: "Content to publish",
        type: "artifact",
      },
    });

    const createContent = createResult.content as Array<{ type: string; text: string }>;
    const createTextContent = createContent.find((item) => item.type === "text");
    const createData = JSON.parse(createTextContent!.text);

    const draftId = createData.draft.id;
    createdDraftId = draftId;

    const result = await client.callTool({
      name: "atlas:drafts_publish",
      arguments: {
        id: draftId,
      },
    });

    assertEquals(Array.isArray(result.content), true);

    const content = result.content as Array<{ type: string; text: string }>;
    const textContent = content.find((item) => item.type === "text");
    const responseData = JSON.parse(textContent!.text);

    // Should have publish result
    assertExists(responseData.published);
    assertEquals(typeof responseData.published, "boolean");
  } finally {
    // Clean up created draft (if not published)
    if (createdDraftId) {
      try {
        await client.callTool({
          name: "atlas:drafts_delete",
          arguments: {
            id: createdDraftId,
          },
        });
      } catch (error) {
        // Ignore errors - draft might have been deleted by publish
      }
    }
    await transport.close();
  }
});

Deno.test("Drafts Tools - delete", async () => {
  const { client, transport } = await createMCPClient();

  try {
    // First create a draft
    const createResult = await client.callTool({
      name: "atlas:drafts_create",
      arguments: {
        name: `test-delete-draft-${Date.now()}`,
        content: "Content to delete",
        type: "document",
      },
    });

    const createContent = createResult.content as Array<{ type: string; text: string }>;
    const createTextContent = createContent.find((item) => item.type === "text");
    const createData = JSON.parse(createTextContent!.text);

    const draftId = createData.draft.id;

    const result = await client.callTool({
      name: "atlas:drafts_delete",
      arguments: {
        id: draftId,
      },
    });

    assertEquals(Array.isArray(result.content), true);

    const content = result.content as Array<{ type: string; text: string }>;
    const textContent = content.find((item) => item.type === "text");
    const responseData = JSON.parse(textContent!.text);

    // Should have delete result
    assertEquals(responseData.deleted, true);
    assertEquals(responseData.id, draftId);
  } finally {
    await transport.close();
  }
});
