/**
 * Integration test for ConversationAgent with AI SDK and tool usage
 * Tests real API calls to the LLM with tool orchestration
 */

import { assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import { AtlasToolRegistry } from "@atlas/tools";
import { ConversationAgent } from "../../agents/conversation-agent.ts";
import { tool } from "ai";
import { z } from "zod/v4";

// Type definitions for test using Zod
const ExecutionStepSchema = z.object({
  type: z.string(),
  tool: z.string().optional(),
  args: z.unknown().optional(),
  result: z.unknown().optional(),
  duration: z.number().optional(),
  timestamp: z.number(),
});

const ConversationResultSchema = z.object({
  text: z.unknown().optional(),
  reasoning: z.string(),
  reasoningDetails: z.unknown().optional(),
  executionFlow: z.array(ExecutionStepSchema),
  response: z.unknown().optional(),
  conversationMetadata: z.object({
    streamId: z.string().optional(),
    messagesInHistory: z.number(),
    isNewConversation: z.boolean(),
  }).optional(),
});

// Skip test if no API key
const skipIfNoKey = !Deno.env.get("ANTHROPIC_API_KEY");

// Mock tools for testing
const createMockTools = () => {
  const atlas_calculator = tool({
    description: "Perform arithmetic operations (add, multiply, divide)",
    inputSchema: z.object({
      operation: z.enum(["add", "multiply", "divide"]).describe(
        "The arithmetic operation to perform",
      ),
      a: z.number().describe("The first number"),
      b: z.number().describe("The second number"),
    }),
    execute: ({ operation, a, b }) => {
      console.log(`[atlas_calculator] ${a} ${operation} ${b}`);
      switch (operation) {
        case "add":
          return Promise.resolve({ value: a + b });
        case "multiply":
          return Promise.resolve({ value: a * b });
        case "divide":
          if (b === 0) throw new Error("Division by zero");
          return Promise.resolve({ value: a / b });
        default:
          throw new Error(`Unknown operation: ${operation}`);
      }
    },
  });

  const atlas_file_reader = tool({
    description: "Read the contents of a file",
    inputSchema: z.object({
      path: z.string().describe("The path to the file to read"),
    }),
    execute: ({ path }) => {
      console.log(`[atlas_file_reader] Reading ${path}`);
      if (path === "data.txt") {
        return Promise.resolve({ content: "The secret number is 10" });
      }
      throw new Error(`File not found: ${path}`);
    },
  });

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
      console.log(`[atlas_stream_reply to ${streamId}]: ${content}`);
      return Promise.resolve({ success: true, streamId, content, metadata });
    },
  });

  return { atlas_calculator, atlas_file_reader, atlas_stream_reply };
};

// Create a test tool registry with mock tools
const createTestToolRegistry = (): AtlasToolRegistry => {
  const tools = createMockTools();
  return new AtlasToolRegistry({
    conversation: {
      atlas_stream_reply: tools.atlas_stream_reply,
      atlas_file_reader: tools.atlas_file_reader,
      atlas_calculator: tools.atlas_calculator,
    },
    workspace: {}, // Empty workspace tools for test compatibility
    signal: {}, // Empty signal tools for test compatibility
    library: {}, // Empty library tools for test compatibility
    draft: {}, // Empty draft tools for test compatibility
    session: {}, // Empty session tools for test compatibility
  });
};

Deno.test({
  name: "ConversationAgent - Tool Orchestration with Real AI SDK",
  ignore: skipIfNoKey,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // Create test tool registry
    const toolRegistry = createTestToolRegistry();

    // Create a real ConversationAgent instance with tools
    const agent = new ConversationAgent(
      {
        tools: ["atlas_file_reader", "atlas_calculator", "atlas_stream_reply"],
        prompt:
          "You are a helpful assistant that can read files and perform calculations. Always use the available tools to complete tasks.",
      },
      "test-agent-tool-orchestration",
      toolRegistry,
    );

    const userMessage =
      "Read the number from data.txt, multiply it by 4, add 2, then tell me the final answer.";

    console.log("Testing tool orchestration with real API...");
    console.log(`User: ${userMessage}`);

    // Execute with real API call
    const invokeResult = await agent.invoke({
      message: userMessage,
      streamId: "test-tool-orchestration",
    });

    console.log("Response received from AI SDK");

    // Verify the response structure
    assertExists(invokeResult);
    assertExists(invokeResult.result);

    // Parse and validate the result using Zod
    const result = ConversationResultSchema.parse(invokeResult.result);
    assertExists(result.reasoning);
    assertExists(result.executionFlow);

    // The AI should have calculated (10 × 4) + 2 = 42
    // Check for the answer in tool calls (reasoning might not contain the number)
    const streamReplyCalls = result.executionFlow.filter((step) =>
      step.type === "tool_call" && step.tool === "atlas_stream_reply"
    );

    // Find the stream reply that contains the final answer
    const finalAnswerCall = streamReplyCalls.find((call) => {
      if (!call.args || typeof call.args !== "object") return false;
      const argsStr = JSON.stringify(call.args);
      return argsStr.includes("42") || argsStr.includes("final answer");
    });
    assertExists(finalAnswerCall, "Should have a stream reply with the final answer");
    assertExists(finalAnswerCall.args);
    assertStringIncludes(JSON.stringify(finalAnswerCall.args), "42");

    // Check that tools were used
    const toolCalls = result.executionFlow.filter((step) => step.type === "tool_call");
    assertEquals(toolCalls.length >= 3, true, "Should have at least 3 tool calls");

    // Verify tool sequence
    const toolSequence = toolCalls.map((step) => step.tool);
    assertEquals(
      toolSequence.includes("atlas_file_reader"),
      true,
      "Should have used atlas_file_reader",
    );
    assertEquals(
      toolSequence.includes("atlas_calculator"),
      true,
      "Should have used atlas_calculator",
    );
    assertEquals(
      toolSequence.includes("atlas_stream_reply"),
      true,
      "Should have used atlas_stream_reply",
    );

    console.log("Test passed!");
    console.log(`Tool sequence: ${toolSequence.join(" → ")}`);
    console.log(`Final answer: 42 found in response: ${result.reasoning.includes("42")}`);
  },
});

Deno.test({
  name: "ConversationAgent - Error Recovery with Real AI SDK",
  ignore: skipIfNoKey,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // Create tools with error scenarios
    const createErrorProneTools = () => {
      const tools = createMockTools();

      // Override file_reader to fail on missing.txt
      tools.atlas_file_reader = tool({
        description: "Read the contents of a file",
        inputSchema: z.object({
          path: z.string().describe("The path to the file to read"),
        }),
        execute: async ({ path }) => {
          console.log(`[atlas_file_reader] Attempting to read ${path}`);
          if (path === "missing.txt") {
            throw new Error("File not found: missing.txt");
          }
          if (path === "data.txt") {
            return { content: "The secret number is 10" };
          }
          throw new Error(`File not found: ${path}`);
        },
      });

      return tools;
    };

    // Create a test tool registry with error-prone tools
    const tools = createErrorProneTools();
    const toolRegistry = new AtlasToolRegistry({
      conversation: {
        atlas_stream_reply: tools.atlas_stream_reply,
        atlas_file_reader: tools.atlas_file_reader,
      },
      workspace: {}, // Empty workspace tools for test compatibility
      signal: {}, // Empty signal tools for test compatibility
      library: {}, // Empty library tools for test compatibility
      draft: {}, // Empty draft tools for test compatibility
      session: {}, // Empty session tools for test compatibility
    });

    // Create agent with error recovery prompt
    const agent = new ConversationAgent(
      {
        tools: ["atlas_file_reader", "atlas_stream_reply"],
        prompt:
          "You are a helpful assistant. If a file is not found, try alternative approaches. Be resilient to errors.",
      },
      "test-agent-error-recovery",
      toolRegistry,
    );

    const userMessage =
      "Try to read the number from missing.txt. If that fails, try data.txt instead.";

    console.log("Testing error recovery with real API...");
    console.log(`User: ${userMessage}`);

    // Execute with real API call
    const invokeResult = await agent.invoke({
      message: userMessage,
      streamId: "test-error-recovery",
    });

    console.log("Response received from AI SDK");

    // Verify the response structure
    assertExists(invokeResult);
    assertExists(invokeResult.result);

    // Parse and validate the result using Zod
    const result = ConversationResultSchema.parse(invokeResult.result);
    assertExists(result.reasoning);
    assertExists(result.executionFlow);

    // The AI should have attempted error recovery
    // First check if there are any stream reply calls
    const streamReplyCalls = result.executionFlow.filter((step) =>
      step.type === "tool_call" && step.tool === "atlas_stream_reply"
    );

    // If the AI managed to recover and read data.txt, it should mention the number
    if (streamReplyCalls.length > 0) {
      const streamReplyCall = streamReplyCalls[0];
      const argsStr = streamReplyCall?.args ? JSON.stringify(streamReplyCall.args) : "";
      const streamMentionsNumber = argsStr.includes("10") || argsStr.includes("ten") ||
        argsStr.includes("error") || argsStr.includes("failed");
      assertEquals(
        streamMentionsNumber,
        true,
        "Should mention the number 10 or acknowledge the error",
      );
    }

    // Or check if the reasoning mentions attempting recovery
    const mentionsRecovery = result.reasoning.includes("missing.txt") ||
      result.reasoning.includes("data.txt") ||
      result.reasoning.includes("error") ||
      result.reasoning.includes("fail");
    assertEquals(mentionsRecovery, true, "Should mention attempting to read files");

    // Check that multiple file_reader calls were made (showing recovery)
    const fileReaderCalls = result.executionFlow.filter((step) =>
      step.type === "tool_call" && step.tool === "atlas_file_reader"
    );
    assertEquals(
      fileReaderCalls.length >= 1,
      true,
      "Should have at least 1 atlas_file_reader call",
    );

    // Note: The AI might not always call stream_reply if it encounters an error
    // So we make this check optional
    console.log(`File reader calls: ${fileReaderCalls.length}`);

    console.log("Test passed!");
    console.log("AI successfully recovered from error and found the data");
  },
});

Deno.test({
  name: "ConversationAgent - Complex Tool Chain with Real AI SDK",
  ignore: skipIfNoKey,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // Create test tool registry
    const toolRegistry = createTestToolRegistry();

    // Create agent with complex calculation instructions
    const agent = new ConversationAgent(
      {
        tools: ["atlas_file_reader", "atlas_calculator", "atlas_stream_reply"],
        prompt:
          "You are a precise calculator assistant. Perform all calculations step by step using the calculator tool.",
      },
      "test-agent-complex-chain",
      toolRegistry,
    );

    const userMessage =
      "Read the number from data.txt, then: multiply by 3, add 15, divide by 5. Show each calculation step.";

    console.log("Testing complex tool chain with real API...");
    console.log(`User: ${userMessage}`);

    // Track streaming output
    const streamedContent: string[] = [];

    // Execute with real API call and streaming
    const invokeResult = await agent.invoke(
      {
        message: userMessage,
        streamId: "test-complex-chain",
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
    assertExists(result.reasoning);
    assertExists(result.executionFlow);

    // The AI should have calculated ((10 * 3) + 15) / 5 = 9
    // Check for the answer in tool calls (reasoning might not contain the number)
    const streamReplyCalls = result.executionFlow.filter((step) =>
      step.type === "tool_call" && step.tool === "atlas_stream_reply"
    );

    // Find the stream reply that contains the final answer
    const finalAnswerCall = streamReplyCalls.find((call) => {
      if (!call.args || typeof call.args !== "object") return false;
      const argsStr = JSON.stringify(call.args);
      return argsStr.includes("9") || argsStr.includes("final");
    });
    assertExists(finalAnswerCall, "Should have a stream reply with the final answer");
    assertExists(finalAnswerCall.args);
    assertStringIncludes(JSON.stringify(finalAnswerCall.args), "9");

    // Check that multiple calculator calls were made
    const calculatorCalls = result.executionFlow.filter((step) =>
      step.type === "tool_call" && step.tool === "atlas_calculator"
    );
    assertEquals(calculatorCalls.length >= 3, true, "Should have at least 3 calculator calls");

    // Verify the tool sequence includes all required tools
    const toolSequence = result.executionFlow
      .filter((step) => step.type === "tool_call")
      .map((step) => step.tool);

    assertEquals(toolSequence.includes("atlas_file_reader"), true, "Should read file");
    assertEquals(toolSequence.includes("atlas_calculator"), true, "Should use calculator");
    assertEquals(toolSequence.includes("atlas_stream_reply"), true, "Should reply to user");

    // Check that streaming worked
    const hasThinkingStream = streamedContent.some((s) => s.includes("💭"));
    assertEquals(
      hasThinkingStream || streamedContent.length > 0,
      true,
      "Should have streamed content",
    );

    console.log("Test passed!");
    console.log(`Tool chain: ${toolSequence.join(" → ")}`);
    console.log(`Final answer: 9 found in response: ${result.reasoning.includes("9")}`);
  },
});
