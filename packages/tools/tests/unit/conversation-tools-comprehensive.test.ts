/**
 * Comprehensive unit tests for all conversation tools
 * Tests both main and internal conversation tools against actual daemon API endpoints
 */

import { assertEquals, assertRejects } from "@std/assert";
import { conversationTools as internalConversationTools } from "../../src/internal/conversation.ts";
import { defaultContext } from "../../src/utils.ts";
import z from "zod/v4";

Deno.test("Conversation Tools - API Endpoint Compatibility", async (t) => {
  await t.step("should have internal conversation tools available", () => {
    const internalToolNames = Object.keys(internalConversationTools);

    // Verify we have the expected tools
    assertEquals(
      internalToolNames.length > 0,
      true,
      "Internal conversation tools should be available",
    );
  });

  await t.step("should have required properties for all tools", () => {
    const allTools = internalConversationTools;

    for (const [toolName, tool] of Object.entries(allTools)) {
      assertEquals("description" in tool, true, `${toolName} should have description`);
      assertEquals("inputSchema" in tool, true, `${toolName} should have inputSchema`);
      assertEquals("execute" in tool, true, `${toolName} should have execute function`);
      assertEquals(typeof tool.execute, "function", `${toolName}.execute should be a function`);
    }
  });
});

Deno.test("atlas_stream_reply - Internal Tool", async (t) => {
  const tool = internalConversationTools.atlas_stream_reply;

  await t.step("should have correct API endpoint format", () => {
    // The tool should target /api/stream/:streamId/emit endpoint
    assertEquals(typeof tool.description, "string");
    assertEquals(tool.description!.includes("Server-Sent Events"), true);
    assertEquals(tool.description!.includes("Emits messages"), true);
  });

  await t.step("should validate main tool parameters", () => {
    const params = tool.inputSchema;
    if (!(params instanceof z.ZodObject)) {
      throw new Error("params is not a z.ZodObject");
    }

    // Valid parameters for main tool (includes streamId)
    const validParams = {
      streamId: "test-stream-123",
      content: "Hello world",
    };
    const result = params.parse(validParams);
    assertEquals(result.streamId, "test-stream-123");
    assertEquals(result.content, "Hello world");

    // With optional metadata
    const validWithMetadata = {
      streamId: "test-stream-123",
      content: "Hello world",
      metadata: { type: "response", source: "agent" },
    };
    const resultWithMeta = params.safeParse(validWithMetadata);
    assertEquals(resultWithMeta.success, true);
  });

  await t.step("should reject invalid parameters", () => {
    const params = tool.inputSchema;
    if (!(params instanceof z.ZodObject)) {
      throw new Error("params is not a z.ZodObject");
    }

    // Missing streamId
    const missingStreamId = { content: "Hello world" };
    assertEquals(params.safeParse(missingStreamId).success, false);

    // Missing content
    const missingContent = { streamId: "test-stream-123" };
    assertEquals(params.safeParse(missingContent).success, false);

    // Invalid content type
    const invalidContent = { streamId: "test-stream-123", content: 123 };
    assertEquals(params.safeParse(invalidContent).success, false);
  });

  await t.step("should construct correct API request format", async () => {
    // Mock fetch to capture the request
    const originalFetch = globalThis.fetch;
    let capturedRequest: { url: string; options: RequestInit } | null = null;

    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      capturedRequest = { url, options: init || {} };
      // Return a mock successful response
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    try {
      await tool.execute({
        streamId: "test-stream-123",
        content: "Test message",
        metadata: { type: "test" },
      }, { toolCallId: "test", messages: [] });

      // Verify the request was made correctly
      assertEquals(capturedRequest !== null, true, "Request should have been made");
      assertEquals(
        capturedRequest!.url,
        `${defaultContext.daemonUrl}/api/stream/test-stream-123/emit`,
        "Should use correct /emit endpoint",
      );
      assertEquals(capturedRequest!.options.method, "POST");

      const requestBody = JSON.parse(capturedRequest!.options.body as string);
      assertEquals(requestBody.type, "message_chunk");
      assertEquals(requestBody.data.content, "Test message");
      assertEquals(requestBody.data.partial, false);
      assertEquals(requestBody.sessionId, "test-stream-123");
      assertEquals(typeof requestBody.timestamp, "string");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

Deno.test("atlas_stream_reply - Internal Tool", async (t) => {
  const tool = internalConversationTools.atlas_stream_reply;

  await t.step("should have same parameters as main tool", () => {
    const params = tool.inputSchema;
    if (!(params instanceof z.ZodObject)) {
      throw new Error("params is not a z.ZodObject");
    }

    // Internal tool now has same interface as main tool
    const validParams = {
      streamId: "test-stream",
      content: "Hello world",
    };
    const result = params.safeParse(validParams);
    assertEquals(result.success, true);

    // Should work with metadata
    const validWithMetadata = {
      streamId: "test-stream",
      content: "Hello world",
      metadata: { type: "response" },
    };
    const resultWithMeta = params.safeParse(validWithMetadata);
    assertEquals(resultWithMeta.success, true);
  });

  await t.step("should work with streamId parameter", async () => {
    const originalFetch = globalThis.fetch;
    let capturedRequest: { url: string; options: RequestInit } | null = null;

    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      capturedRequest = { url, options: init || {} };
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    try {
      await tool.execute({
        streamId: "internal-stream-123",
        content: "Hello world",
      }, { toolCallId: "test", messages: [] });

      assertEquals(capturedRequest !== null, true, "Request should have been made");
      assertEquals(
        capturedRequest!.url,
        `${defaultContext.daemonUrl}/api/stream/internal-stream-123/emit`,
        "Should use correct /emit endpoint",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

Deno.test("atlas_conversation_storage - API Endpoint Mapping", async (t) => {
  const tool = internalConversationTools.atlas_conversation_storage;

  await t.step("should map operations to correct endpoints", async () => {
    const originalFetch = globalThis.fetch;
    const capturedRequests: Array<{ url: string; options: RequestInit }> = [];

    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      capturedRequests.push({ url, options: init || {} });
      return new Response(JSON.stringify({ success: true, result: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    try {
      // Test store operation
      await tool.execute({
        operation: "store",
        streamId: "test-stream",
        data: { message: "Hello", role: "user" },
      }, { toolCallId: "test", messages: [] });
      assertEquals(
        capturedRequests[0].url,
        `${defaultContext.daemonUrl}/api/conversation-storage/test-stream`,
      );
      assertEquals(capturedRequests[0].options.method, "POST");

      // Test retrieve operation
      await tool.execute({
        operation: "retrieve",
        streamId: "test-stream",
      }, { toolCallId: "test", messages: [] });
      assertEquals(
        capturedRequests[1].url,
        `${defaultContext.daemonUrl}/api/conversation-storage/test-stream`,
      );
      assertEquals(capturedRequests[1].options.method, "GET");

      // Test list operation (offset 0 is falsy so won't be included)
      await tool.execute({
        operation: "list",
        limit: 10,
        offset: 0,
      }, { toolCallId: "test", messages: [] });
      // Check that the URL contains the expected parameters (order may vary)
      const listUrl = new URL(capturedRequests[2].url);
      assertEquals(listUrl.pathname, "/api/conversation-storage");
      assertEquals(listUrl.searchParams.get("limit"), "10");
      // offset=0 is falsy so it won't be added to the URL
      assertEquals(listUrl.searchParams.get("offset"), null);
      assertEquals(capturedRequests[2].options.method, "GET");

      // Test delete operation
      await tool.execute({
        operation: "delete",
        streamId: "test-stream",
      }, { toolCallId: "test", messages: [] });
      assertEquals(
        capturedRequests[3]?.url,
        `${defaultContext.daemonUrl}/api/conversation-storage/test-stream`,
      );
      assertEquals(capturedRequests[3]?.options.method, "DELETE");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await t.step("should validate operation-specific requirements", () => {
    const params = tool.inputSchema;
    if (!(params instanceof z.ZodObject)) {
      throw new Error("params is not a z.ZodObject");
    }

    // Store requires streamId and data
    const validStore = {
      operation: "store",
      streamId: "test-stream",
      data: { message: "Hello" },
    };
    assertEquals(params.safeParse(validStore).success, true);

    const invalidStore = { operation: "store", streamId: "test-stream" }; // missing data
    assertEquals(params.safeParse(invalidStore).success, false);

    // Retrieve requires streamId
    const validRetrieve = { operation: "retrieve", streamId: "test-stream" };
    assertEquals(params.safeParse(validRetrieve).success, true);

    const invalidRetrieve = { operation: "retrieve" }; // missing streamId
    assertEquals(params.safeParse(invalidRetrieve).success, false);

    // List doesn't require streamId
    const validList = { operation: "list" };
    assertEquals(params.safeParse(validList).success, true);

    // Delete requires streamId
    const validDelete = { operation: "delete", streamId: "test-stream" };
    assertEquals(params.safeParse(validDelete).success, true);

    const invalidDelete = { operation: "delete" }; // missing streamId
    assertEquals(params.safeParse(invalidDelete).success, false);
  });
});

Deno.test("Tool Error Handling", async (t) => {
  await t.step("should handle daemon API errors correctly", async () => {
    const originalFetch = globalThis.fetch;

    // Mock 404 error
    globalThis.fetch = async () => {
      return new Response(JSON.stringify({ error: "Not Found" }), {
        status: 404,
        statusText: "Not Found",
      });
    };

    try {
      await assertRejects(
        () =>
          internalConversationTools.atlas_stream_reply.execute({
            streamId: "test-stream",
            content: "Hello",
          }, { toolCallId: "test", messages: [] }),
        Error,
        "Failed to send streaming reply",
      );

      await assertRejects(
        () =>
          internalConversationTools.atlas_conversation_storage.execute({
            operation: "store",
            streamId: "test-stream",
            data: { message: "Hello" },
          }, { toolCallId: "test", messages: [] }),
        Error,
        "Failed to manage conversation storage",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await t.step("should handle network timeouts", async () => {
    const originalFetch = globalThis.fetch;

    // Mock network timeout
    globalThis.fetch = async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      throw new Error("Network timeout");
    };

    try {
      await assertRejects(
        () =>
          internalConversationTools.atlas_stream_reply.execute({
            streamId: "test-stream",
            content: "Hello",
          }, { toolCallId: "test", messages: [] }),
        Error,
        "Failed to send streaming reply",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

Deno.test("API Response Format Validation", async (t) => {
  await t.step("should handle valid API responses", async () => {
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async () => {
      return new Response(
        JSON.stringify({
          success: true,
          streamId: "test-stream",
          result: "Message sent successfully",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    };

    try {
      const result = await internalConversationTools.atlas_stream_reply.execute({
        streamId: "test-stream",
        content: "Hello",
      }, { toolCallId: "test", messages: [] });

      assertEquals(result.success, true);
      assertEquals(result.streamId, "test-stream");
      assertEquals(result.content, "Hello");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await t.step("should handle conversation storage list response", async () => {
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async () => {
      return new Response(
        JSON.stringify({
          success: true,
          conversations: [
            {
              streamId: "stream-1",
              messageCount: 5,
              lastMessage: "Hello there",
              lastTimestamp: "2024-01-01T00:00:00.000Z",
            },
          ],
          total: 1,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    };

    try {
      const result = await internalConversationTools.atlas_conversation_storage.execute({
        operation: "list",
      }, { toolCallId: "test", messages: [] });

      assertEquals(result.success, true);
      assertEquals(result.operation, "list");
      assertEquals(typeof result.result, "object");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
