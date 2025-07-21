/**
 * Unit tests for conversation tools
 */

import { assertEquals, assertRejects } from "@std/assert";
import { conversationTools } from "../../src/conversation.ts";

Deno.test("Conversation Tools", async (t) => {
  await t.step("should have all expected tools", () => {
    const expectedTools = [
      "atlas_stream_reply",
      "atlas_conversation_storage",
    ];

    for (const toolName of expectedTools) {
      assertEquals(toolName in conversationTools, true);
      assertEquals(typeof conversationTools[toolName as keyof typeof conversationTools], "object");
    }
  });

  await t.step("all tools should have required properties", () => {
    for (const [toolName, tool] of Object.entries(conversationTools)) {
      assertEquals("description" in tool, true, `${toolName} should have description`);
      assertEquals("parameters" in tool, true, `${toolName} should have parameters`);
      assertEquals("execute" in tool, true, `${toolName} should have execute function`);
      assertEquals(typeof tool.execute, "function", `${toolName}.execute should be a function`);
    }
  });
});

Deno.test("atlas_stream_reply tool", async (t) => {
  const tool = conversationTools.atlas_stream_reply;

  await t.step("should have correct description", () => {
    assertEquals(typeof tool.description, "string");
    assertEquals(tool.description!.includes("streaming reply"), true);
  });

  await t.step("should validate parameters schema", () => {
    const params = tool.parameters;

    // Valid with required parameters
    const validParams = {
      streamId: "stream-123",
      content: "Hello world",
    };
    const result = params.safeParse(validParams);
    assertEquals(result.success, true);

    // Valid with optional parameters
    const validWithOptional = {
      streamId: "stream-123",
      content: "Hello world",
      metadata: { type: "message" },
    };
    const resultOptional = params.safeParse(validWithOptional);
    assertEquals(resultOptional.success, true);
  });

  await t.step("should reject invalid parameters", () => {
    const params = tool.parameters;

    // Missing required streamId
    const invalid1 = { content: "Hello world" };
    assertEquals(params.safeParse(invalid1).success, false);

    // Missing required content
    const invalid2 = { streamId: "stream-123" };
    assertEquals(params.safeParse(invalid2).success, false);
  });

  await t.step("should fail when daemon is not available", async () => {
    await assertRejects(
      () =>
        tool.execute({
          streamId: "stream-123",
          content: "Hello world",
        }, { toolCallId: "test", messages: [] }),
      Error,
      "Failed to send streaming reply",
    );
  });
});

Deno.test("atlas_conversation_storage tool", async (t) => {
  const tool = conversationTools.atlas_conversation_storage;

  await t.step("should have correct description", () => {
    assertEquals(typeof tool.description, "string");
    assertEquals(tool.description!.includes("conversation history"), true);
  });

  await t.step("should validate parameters schema", () => {
    const params = tool.parameters;

    // Valid store operation
    const validStore = {
      operation: "store",
      streamId: "stream-123",
      data: { message: "Hello world" },
    };
    assertEquals(params.safeParse(validStore).success, true);

    // Valid retrieve operation
    const validRetrieve = {
      operation: "retrieve",
      streamId: "stream-123",
    };
    assertEquals(params.safeParse(validRetrieve).success, true);

    // Valid list operation
    const validList = {
      operation: "list",
    };
    assertEquals(params.safeParse(validList).success, true);

    // Valid delete operation
    const validDelete = {
      operation: "delete",
      streamId: "stream-123",
    };
    assertEquals(params.safeParse(validDelete).success, true);
  });

  await t.step("should reject invalid parameters", () => {
    const params = tool.parameters;

    // Missing required operation
    const invalid1 = { streamId: "stream-123" };
    assertEquals(params.safeParse(invalid1).success, false);

    // Invalid operation
    const invalid2 = { operation: "invalid" };
    assertEquals(params.safeParse(invalid2).success, false);

    // Store operation without data
    const invalid3 = { operation: "store", streamId: "stream-123" };
    assertEquals(params.safeParse(invalid3).success, false);

    // Retrieve operation without streamId
    const invalid4 = { operation: "retrieve" };
    assertEquals(params.safeParse(invalid4).success, false);
  });

  await t.step("should fail when daemon is not available", async () => {
    await assertRejects(
      () =>
        tool.execute({
          operation: "store",
          streamId: "stream-123",
          data: { message: "Hello world" },
        }, { toolCallId: "test", messages: [] }),
      Error,
      "Failed to manage conversation storage",
    );
  });
});
