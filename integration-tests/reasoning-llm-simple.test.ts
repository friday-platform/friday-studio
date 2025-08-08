/**
 * Simple integration test for ConversationAgent with AI SDK
 * Tests real API calls to the LLM for simple reasoning tasks
 */

import { assertEquals, assertExists, assertStringIncludes } from "@std/assert";
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
  text: z.unknown().optional(), // Can be a promise, string, or object
  reasoning: z.union([z.array(z.string()), z.array(z.unknown())]).optional(),
  reasoningText: z.string().optional(),
  reasoningDetails: z.unknown().optional(),
  executionFlow: z.array(ExecutionStepSchema),
  response: z.unknown().optional(), // Can be a promise, string, or object
  conversationMetadata: z.object({
    streamId: z.string().optional(),
    messagesInHistory: z.number(),
    isNewConversation: z.boolean(),
  }).optional(),
});

// Types are inferred from Zod schemas

// Skip tests in CI or when no API key is available
const skipIfNoKey = !Deno.env.get("ANTHROPIC_API_KEY") || Deno.env.get("CI") === "true" ||
  Deno.env.get("GITHUB_ACTIONS") === "true";

// Mock atlas_stream_reply tool for tests
const createMockStreamReplyTool = () =>
  tool({
    description: "Send a streaming reply to a stream via Server-Sent Events (SSE)",
    inputSchema: z.object({
      streamId: z.string().describe("The unique identifier of the stream to send the reply to"),
      content: z.string().describe("The content to send as a streaming reply"),
      metadata: z.record(z.string(), z.unknown()).optional().describe(
        "Optional metadata to include with the reply",
      ),
    }),
    execute: ({ streamId, content, metadata }) => {
      console.log(`[atlas_stream_reply to ${streamId}]: ${content}`);
      return Promise.resolve({ success: true, streamId, content, metadata });
    },
  });

// Create a test tool registry with mock tools
const createTestToolRegistry = (): AtlasToolRegistry => {
  // Create atlas_stream_event mock using real tool object with mocked execute
  const atlas_stream_event = {
    ...conversationTools.atlas_stream_event,
    execute: async ({ streamId, eventType, content, metadata }: any) => {
      console.log(`[atlas_stream_event] ${eventType} to ${streamId}: ${content}`);
      return Promise.resolve({ success: true, streamId, eventType, content, metadata });
    },
  };

  return new AtlasToolRegistry({
    conversation: {
      atlas_stream_reply: createMockStreamReplyTool(),
      atlas_stream_event: atlas_stream_event,
    },
    workspace: {}, // Empty workspace tools for test compatibility
    signal: {}, // Empty signal tools for test compatibility
    library: {}, // Empty library tools for test compatibility
    session: {}, // Empty session tools for test compatibility
  });
};

Deno.test({
  name: "ConversationAgent - Simple Math Reasoning with Real AI SDK",
  ignore: skipIfNoKey,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // Create test tool registry
    const toolRegistry = createTestToolRegistry();

    // Create a real ConversationAgent instance with dependency injection
    const agent = new ConversationAgent(
      {
        temperature: 0.3,
        tools: ["atlas_stream_reply"],
        prompt: "You are a helpful math assistant. Be concise in your responses.",
      },
      "test-agent-simple-math",
      toolRegistry,
    );

    const userMessage = "Calculate 25 + 17. Just give me the answer.";

    console.log("Testing simple math reasoning with real API...");
    console.log(`User: ${userMessage}`);

    // Execute with real API call
    const invokeResult = await agent.invoke({
      message: userMessage,
      streamId: "test-simple-math",
      type: "user",
    });

    console.log("Response received from AI SDK");

    // Verify the response structure
    assertExists(invokeResult);
    assertExists(invokeResult.result);

    // Parse and validate the result using Zod
    const result = ConversationResultSchema.parse(invokeResult.result);
    console.log("Result structure:", JSON.stringify(result, null, 2));
    assertExists(result.reasoning || result.reasoningText);
    assertExists(result.executionFlow);

    // The AI should have calculated 42 - check in the reasoning or tool calls
    // Since text is a promise object, we'll check the reasoning and tool execution
    const reasoningContent = result.reasoningText ||
      (result.reasoning ? result.reasoning.join("\n") : "");
    assertStringIncludes(reasoningContent, "42");

    // Also verify the tool was called with the correct answer
    const toolCall = result.executionFlow.find((step) =>
      step.type === "tool_call" && step.tool === "atlas_stream_reply"
    );
    assertExists(toolCall);
    assertExists(toolCall.args);
    assertStringIncludes(JSON.stringify(toolCall.args), "42");

    // Check execution flow has reasoning steps
    assertEquals(result.executionFlow.length > 0, true, "Should have execution steps");

    // Find atlas_stream_reply tool calls
    const streamReplyCalls = result.executionFlow.filter((step) =>
      step.type === "tool_call" && step.tool === "atlas_stream_reply"
    );
    assertEquals(streamReplyCalls.length > 0, true, "Should have called atlas_stream_reply");

    console.log("Test passed!");
    console.log(
      `Final answer found in response: ${result.reasoning.includes("42") ? "42" : "not found"}`,
    );
  },
});

Deno.test({
  name: "ConversationAgent - Multi-step Reasoning with Real AI SDK",
  ignore: skipIfNoKey,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // Create test tool registry
    const toolRegistry = createTestToolRegistry();

    // Create a real ConversationAgent instance with dependency injection
    const agent = new ConversationAgent(
      {
        temperature: 0.3,
        tools: ["atlas_stream_reply"],
        prompt: "You are a helpful math assistant. Show your work step by step.",
      },
      "test-agent-multi-step",
      toolRegistry,
    );

    const userMessage = "Calculate (10 * 5 + 25) / 3. Show your work step by step.";

    console.log("Testing multi-step reasoning with real API...");
    console.log(`User: ${userMessage}`);

    // Track streaming output
    const streamedContent: string[] = [];

    // Execute with real API call and streaming
    const invokeResult = await agent.invoke(
      {
        message: userMessage,
        streamId: "test-multi-step",
        type: "user",
      },
      (data: string) => {
        streamedContent.push(data);
        console.log(`Stream: ${data}`);
      },
    );

    console.log("Response received from AI SDK");

    // Verify the response structure
    assertExists(invokeResult);
    assertExists(invokeResult.result);

    // Parse and validate the result using Zod
    const result = ConversationResultSchema.parse(invokeResult.result);
    console.log("Result structure:", JSON.stringify(result, null, 2));
    assertExists(result.reasoning || result.reasoningText);
    assertExists(result.executionFlow);

    // The AI should have calculated 25 - check in the reasoning or tool calls
    const reasoningContent = result.reasoningText ||
      (result.reasoning ? result.reasoning.join("\n") : "");
    assertStringIncludes(reasoningContent, "25");

    // Also verify the tool was called with the correct answer
    const toolCall = result.executionFlow.find((step) =>
      step.type === "tool_call" && step.tool === "atlas_stream_reply"
    );
    assertExists(toolCall);
    assertExists(toolCall.args);
    assertStringIncludes(JSON.stringify(toolCall.args), "25");

    // Check that the response shows the work
    const toolCallArgsStr = JSON.stringify(toolCall.args);
    const reasoningStr = typeof result.reasoning === "string"
      ? result.reasoning
      : JSON.stringify(result.reasoning);
    const hasStepByStep = toolCallArgsStr.toLowerCase().includes("step") ||
      reasoningStr.toLowerCase().includes("step");
    assertEquals(hasStepByStep, true, "Should show step-by-step work");

    // Verify intermediate calculations are shown
    const hasIntermediateCalcs =
      (toolCallArgsStr.includes("50") || toolCallArgsStr.includes("75")) ||
      (reasoningStr.includes("50") || reasoningStr.includes("75"));
    assertEquals(hasIntermediateCalcs, true, "Should show intermediate calculations");

    // Check streaming worked
    assertEquals(streamedContent.length > 0, true, "Should have streamed content");

    // Verify that thinking content was streamed
    const hasThinkingContent = streamedContent.some((content) => content.includes("💭"));
    assertEquals(hasThinkingContent, true, "Should have streamed thinking content");

    // Verify that the final answer was part of the stream
    const streamedText = streamedContent.join("");
    const hasFinalAnswer = streamedText.includes("25") || streamedText.includes("step");
    assertEquals(hasFinalAnswer, true, "Should have streamed content related to the answer");

    console.log("Test passed!");
    console.log(`Final answer: 25 found in response: ${reasoningStr.includes("25")}`);
  },
});
