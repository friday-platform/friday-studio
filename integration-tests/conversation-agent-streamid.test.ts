/**
 * Integration test for ConversationAgent streamId injection
 * Tests that the conversation agent correctly injects streamId into atlas_stream_reply calls
 * This ensures the fix for the missing streamId parameter doesn't regress
 *
 * Background: After the AI SDK reasoning migration refactor, the conversation agent
 * stopped injecting streamId into atlas_stream_reply tool calls, causing messages
 * to fail reaching the UI. This test verifies the wrapper correctly injects the
 * streamId parameter even when the AI doesn't provide it.
 *
 * Related commits:
 * - Working: 06836d5dc4802223ecde809316cfb5cccbd31abd
 * - Broken: 4a344cd42082cff4db79619ef3c61f3c511743bf (refactor removed wrapper)
 */

import { assertEquals, assertExists } from "@std/assert";
import { AtlasToolRegistry, conversationTools } from "@atlas/tools";
import { tool } from "ai";
import { z } from "zod/v4";
import { ConversationAgent } from "../packages/system/agents/conversation-agent.ts";

// Type definitions for test using Zod
const ExecutionStepSchema = z.object({
  type: z.string(),
  tool: z.string().optional(),
  args: z.unknown().optional(),
  timestamp: z.number(),
  result: z.unknown().optional(),
  duration: z.number().optional(),
});

const ConversationResultSchema = z.object({
  text: z.unknown().optional(),
  reasoning: z.union([z.array(z.string()), z.array(z.unknown())]).optional(),
  reasoningText: z.string().optional(),
  reasoningDetails: z.unknown().optional(),
  executionFlow: z.array(ExecutionStepSchema),
  response: z.unknown().optional(),
  toolCalls: z.array(z.object({
    type: z.string(),
    tool: z.string().optional(),
    args: z.unknown().optional(),
    timestamp: z.number(),
  })).optional(),
  conversationMetadata: z.object({
    streamId: z.string().optional(),
    messagesInHistory: z.number(),
    isNewConversation: z.boolean(),
  }).optional(),
});

// Skip tests in CI or when no API key is available
const skipIfNoKey = !Deno.env.get("ANTHROPIC_API_KEY") || Deno.env.get("CI") === "true" ||
  Deno.env.get("GITHUB_ACTIONS") === "true";

// Create test-specific tools
const createTestTools = () => {
  // Track all calls to atlas_stream_reply
  const streamReplyCalls: Array<{ streamId?: string; content: string; metadata?: unknown }> = [];

  // Mock atlas_stream_reply that captures parameters
  const atlas_stream_reply = tool({
    description: "Send a streaming reply to a stream via Server-Sent Events (SSE)",
    inputSchema: z.object({
      streamId: z.string().describe("The unique identifier of the stream to send the reply to"),
      content: z.string().describe("The content to send as a streaming reply"),
      metadata: z.record(z.string(), z.unknown()).optional().describe(
        "Optional metadata to include with the reply",
      ),
    }),
    execute: ({ streamId, content, metadata }) => {
      console.log(`[atlas_stream_reply] Called with streamId: ${streamId}, content: ${content}`);
      streamReplyCalls.push({ streamId, content, metadata });
      return Promise.resolve({ success: true, streamId, content, metadata });
    },
  });

  // Mock conversation storage tool
  const atlas_conversation_storage = tool({
    description: "Manage conversation history using stream_id as key",
    inputSchema: z.object({
      operation: z.enum(["store", "retrieve", "list", "delete"]),
      streamId: z.string().optional(),
      data: z.record(z.string(), z.unknown()).optional(),
      limit: z.number().optional(),
      offset: z.number().optional(),
    }),
    execute: ({ operation, streamId }) => {
      console.log(`[atlas_conversation_storage] ${operation} for streamId: ${streamId}`);
      if (operation === "retrieve") {
        return Promise.resolve({
          success: true,
          operation,
          streamId,
          result: null, // No history
        });
      }
      return Promise.resolve({ success: true, operation, streamId });
    },
  });

  // Create atlas_stream_event mock using real tool object with mocked execute
  const atlas_stream_event = {
    ...conversationTools.atlas_stream_event,
    execute: async ({ streamId, eventType, content, metadata }: any) => {
      console.log(`[atlas_stream_event] ${eventType} to ${streamId}: ${content}`);
      return Promise.resolve({ success: true, streamId, eventType, content, metadata });
    },
  };

  return { atlas_stream_reply, atlas_conversation_storage, atlas_stream_event, streamReplyCalls };
};

// Create test tool registry
const createTestToolRegistry = (tools: ReturnType<typeof createTestTools>) => {
  return new AtlasToolRegistry({
    conversation: {
      atlas_stream_reply: tools.atlas_stream_reply,
      atlas_conversation_storage: tools.atlas_conversation_storage,
      atlas_stream_event: tools.atlas_stream_event,
    },
    workspace: {}, // Empty workspace tools for test compatibility
    signal: {}, // Empty signal tools for test compatibility
    library: {}, // Empty library tools for test compatibility
    session: {}, // Empty session tools for test compatibility
  });
};

Deno.test({
  name: "ConversationAgent - StreamId Injection with Real AI SDK",
  ignore: skipIfNoKey,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // Create test tools
    const tools = createTestTools();
    const toolRegistry = createTestToolRegistry(tools);

    // Create ConversationAgent with the tools
    const agent = new ConversationAgent(
      {
        temperature: 0.3,
        tools: ["atlas_stream_reply", "atlas_conversation_storage"],
        prompt:
          "You are a helpful assistant. Always respond to the user using the atlas_stream_reply tool.",
      },
      "test-agent-streamid-injection",
      toolRegistry,
    );

    const testStreamId = "test-stream-123";
    const userMessage = "Hello! Please say hi back to me.";

    console.log("Testing streamId injection with real API...");
    console.log(`User message: ${userMessage}`);
    console.log(`Test streamId: ${testStreamId}`);

    // Execute with real API call
    const invokeResult = await agent.invoke({
      message: userMessage,
      streamId: testStreamId,
      userId: "test-user",
    });

    console.log("Response received from AI SDK");

    // Verify the response structure
    assertExists(invokeResult);
    assertExists(invokeResult.result);

    // Parse and validate the result
    const result = ConversationResultSchema.parse(invokeResult.result);
    assertExists(result.reasoning);
    assertExists(result.executionFlow);

    // Check that atlas_stream_reply was called
    const streamReplyCalls = result.executionFlow.filter((step) =>
      step.type === "tool_call" && step.tool === "atlas_stream_reply"
    );
    assertEquals(streamReplyCalls.length > 0, true, "Should have called atlas_stream_reply");

    // Verify the actual tool was called with the injected streamId
    assertEquals(tools.streamReplyCalls.length > 0, true, "Tool should have been executed");

    // Check that the streamId was correctly injected
    const firstCall = tools.streamReplyCalls[0];
    assertEquals(firstCall.streamId, testStreamId, "StreamId should be injected correctly");
    assertExists(firstCall.content, "Should have content in the response");

    // The content should be a greeting response
    const content = firstCall.content.toLowerCase();
    const hasGreeting = content.includes("hi") || content.includes("hello") ||
      content.includes("greet") || content.includes("nice to meet");
    assertEquals(hasGreeting, true, "Should have a greeting in the response");

    // Verify toolCalls are tracked
    if (result.toolCalls) {
      assertEquals(result.toolCalls.length > 0, true, "Should have toolCalls tracked");
      const streamReplyCall = result.toolCalls.find((call) => call.tool === "atlas_stream_reply");
      assertExists(streamReplyCall, "Should have atlas_stream_reply in toolCalls");
    }

    console.log("Test passed!");
    console.log(`Tool was called ${tools.streamReplyCalls.length} times`);
    console.log(`StreamId was correctly injected: ${testStreamId}`);
    console.log(`Response: ${firstCall.content}`);
  },
});

Deno.test({
  name: "ConversationAgent - Multiple StreamId Injections",
  ignore: skipIfNoKey,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // Test that streamId injection works correctly across multiple messages
    const tools = createTestTools();
    const toolRegistry = createTestToolRegistry(tools);

    const agent = new ConversationAgent(
      {
        temperature: 0.3,
        tools: ["atlas_stream_reply", "atlas_conversation_storage"],
        prompt: "You are a helpful assistant. Always respond using atlas_stream_reply.",
      },
      "test-agent-multiple-streams",
      toolRegistry,
    );

    // Test with different streamIds
    const testCases = [
      { streamId: "stream-1", message: "What is 2+2?" },
      { streamId: "stream-2", message: "What is the capital of France?" },
      { streamId: "stream-3", message: "Tell me a joke." },
    ];

    for (const testCase of testCases) {
      console.log(`\nTesting with streamId: ${testCase.streamId}`);
      console.log(`Message: ${testCase.message}`);

      // Clear previous calls
      tools.streamReplyCalls.length = 0;

      // Execute
      const invokeResult = await agent.invoke({
        message: testCase.message,
        streamId: testCase.streamId,
        userId: "test-user",
      });

      // Verify
      assertExists(invokeResult);
      assertExists(invokeResult.result);

      const result = ConversationResultSchema.parse(invokeResult.result);

      // Check tool was called
      assertEquals(tools.streamReplyCalls.length > 0, true, "Tool should have been executed");

      // Verify correct streamId injection
      const call = tools.streamReplyCalls[0];
      assertEquals(call.streamId, testCase.streamId, `StreamId should be ${testCase.streamId}`);
      assertExists(call.content, "Should have content");

      console.log(`✓ StreamId correctly injected: ${call.streamId}`);
      console.log(`✓ Response: ${call.content.substring(0, 50)}...`);
    }

    console.log("\nAll streamId injections worked correctly!");
  },
});

Deno.test({
  name: "ConversationAgent - Missing StreamId Handling",
  ignore: skipIfNoKey,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // Test that the agent handles missing streamId gracefully
    const tools = createTestTools();
    const toolRegistry = createTestToolRegistry(tools);

    const agent = new ConversationAgent(
      {
        temperature: 0.3,
        tools: ["atlas_stream_reply", "atlas_conversation_storage"],
        prompt: "You are a helpful assistant. Always respond using atlas_stream_reply.",
      },
      "test-agent-no-streamid",
      toolRegistry,
    );

    console.log("Testing conversation without streamId...");

    // Execute without streamId
    const invokeResult = await agent.invoke({
      message: "Hello! Can you hear me?",
      // No streamId provided
      userId: "test-user",
    });

    // Should still work but atlas_stream_reply might fail or handle it differently
    assertExists(invokeResult);
    assertExists(invokeResult.result);

    const result = ConversationResultSchema.parse(invokeResult.result);
    assertExists(result.reasoning);
    assertExists(result.executionFlow);

    // Check if tool was attempted
    const streamReplyCalls = result.executionFlow.filter((step) =>
      step.type === "tool_call" && step.tool === "atlas_stream_reply"
    );

    if (streamReplyCalls.length > 0) {
      // If tool was called, it should have handled missing streamId
      console.log("Tool was called despite missing streamId");

      // The wrapper should have caught this case
      if (tools.streamReplyCalls.length === 0) {
        console.log("✓ Tool wrapper prevented execution without streamId");
      } else {
        console.log("✓ Tool executed with undefined streamId");
      }
    } else {
      console.log("✓ Agent didn't attempt to use atlas_stream_reply without streamId");
    }

    console.log("Test passed - missing streamId handled appropriately");
  },
});
