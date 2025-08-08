/**
 * Comprehensive test suite for LLMProvider
 * Tests all methods, providers, and edge cases
 */

import { expect } from "@std/expect";
import { type LLMOptions, LLMProvider, type LLMResponse } from "../src/llm-provider.ts";
import { Tool } from "ai";
import { z } from "zod/v4";

// Test constants
const TEST_PROMPT = "What is 2+2? Answer with just the number.";
const COMPLEX_PROMPT = "Explain the concept of recursion in programming.";

// Mock LLM Provider for testing without API keys
class MockLLMProvider {
  private static mockResponses = new Map<string, string>();

  static setMockResponse(pattern: string, response: string) {
    this.mockResponses.set(pattern, response);
  }

  static getMockResponse(prompt: string): string {
    for (const [pattern, response] of this.mockResponses) {
      if (prompt.includes(pattern)) {
        return response;
      }
    }
    return "Mock LLM response";
  }

  static reset() {
    this.mockResponses.clear();
  }
}

// Helper function to check if API keys are available
function hasAPIKeys(): boolean {
  // Force mock usage if explicitly requested
  if (Deno.env.get("ATLAS_USE_LLM_MOCKS") === "true") {
    return false;
  }

  // Also force mock usage if we're in a test environment
  if (Deno.env.get("NODE_ENV") === "test") {
    return false;
  }

  // Only check for ANTHROPIC_API_KEY since that's the default provider
  return !!Deno.env.get("ANTHROPIC_API_KEY");
}

// Helper function to setup mock LLM provider
function setupMockLLMProvider() {
  const originalGenerateText = LLMProvider.generateText;
  const originalGenerateTextStream = LLMProvider.generateTextStream;

  // Mock responses for common test prompts
  MockLLMProvider.setMockResponse("2+2", "4");
  MockLLMProvider.setMockResponse("multiply 15 by 7", "105");
  MockLLMProvider.setMockResponse("capital of France", "Paris");
  MockLLMProvider.setMockResponse("pirate", "Ahoy matey! Arr, ye be askin' me something!");
  MockLLMProvider.setMockResponse(
    "haiku about coding",
    "Code flows like water\nBugs dance in morning sunlight\nPeace found in brackets",
  );
  MockLLMProvider.setMockResponse(
    "recursion",
    "Recursion is a programming technique where a function calls itself to solve smaller instances of the same problem.",
  );
  MockLLMProvider.setMockResponse("Hello", "Ahoy there, matey!");
  MockLLMProvider.setMockResponse(
    "previous question",
    "You asked about the capital of France earlier.",
  );
  MockLLMProvider.setMockResponse("long essay", "Computing history began with...");
  MockLLMProvider.setMockResponse("Calculate 2+2", "The answer is 4");
  MockLLMProvider.setMockResponse("weather", "I'll check the weather for you");

  // Override LLMProvider methods with mocked versions
  LLMProvider.generateText = async (prompt: string, options: LLMOptions): Promise<LLMResponse> => {
    // Still validate provider even in mock mode
    if (options.provider && !["anthropic", "openai", "google"].includes(options.provider)) {
      throw new Error(`Invalid provider: ${options.provider}`);
    }

    const responseText = MockLLMProvider.getMockResponse(prompt);

    // Handle tool calls
    const toolCalls = [];
    const toolResults = [];
    const steps = [];

    if (options.tools && Object.keys(options.tools).length > 0) {
      const toolName = Object.keys(options.tools)[0];
      if (prompt.includes("multiply 15 by 7") || prompt.includes("calculator")) {
        toolCalls.push({
          toolCallId: "mock-tool-call-123",
          toolName,
          args: { operation: "multiply", a: 15, b: 7 },
        });
        toolResults.push({
          toolCallId: "mock-tool-call-123",
          result: { result: 105 },
        });
      } else if (options.tool_choice === "required") {
        // Force tool use when required
        toolCalls.push({
          toolCallId: "mock-tool-call-123",
          toolName,
          args: { operation: "add", a: 2, b: 2 },
        });
        toolResults.push({
          toolCallId: "mock-tool-call-123",
          result: { result: 4 },
        });
      }
    }

    return Promise.resolve({
      text: responseText,
      toolCalls,
      toolResults,
      steps,
    });
  };

  LLMProvider.generateTextStream = function* (
    prompt: string,
    _options: LLMOptions,
  ): AsyncIterableIterator<string> {
    const responseText = MockLLMProvider.getMockResponse(prompt);
    const chunks = responseText.split(" ");

    for (const chunk of chunks) {
      yield chunk + " ";
    }
  };

  // Store originals for restoration
  (globalThis as Record<string, unknown>).__originalLLMProvider = {
    generateText: originalGenerateText,
    generateTextStream: originalGenerateTextStream,
  };
}

function teardownMockLLMProvider() {
  const global = globalThis as Record<string, unknown>;
  if (global.__originalLLMProvider) {
    const original = global.__originalLLMProvider as {
      generateText: typeof LLMProvider.generateText;
      generateTextStream: typeof LLMProvider.generateTextStream;
    };
    LLMProvider.generateText = original.generateText;
    LLMProvider.generateTextStream = original.generateTextStream;
    delete global.__originalLLMProvider;
  }
  MockLLMProvider.reset();
}

// Helper function to wrap test functions with mock setup/teardown
function withMockLLMProvider(testFn: () => Promise<void>) {
  return async () => {
    const shouldUseMock = !hasAPIKeys();

    if (shouldUseMock) {
      // Set environment variables to trigger mock mode in LLMProvider
      Deno.env.set("ATLAS_USE_LLM_MOCKS", "true");
      setupMockLLMProvider();
    }

    try {
      await testFn();
    } finally {
      if (shouldUseMock) {
        teardownMockLLMProvider();
        Deno.env.delete("ATLAS_USE_LLM_MOCKS");
      }
    }
  };
}

// Mock tool for testing - use Zod schema for AI SDK
const mockCalculatorTool: Tool = {
  description: "Perform basic calculations",
  inputSchema: z.object({
    operation: z.enum(["add", "subtract", "multiply", "divide"]).describe("The operation to perform"),
    a: z.number().describe("First number"),
    b: z.number().describe("Second number"),
  }),
  execute: ({ operation, a, b }: { operation: string; a: number; b: number }) => {
    switch (operation) {
      case "add":
        return Promise.resolve({ result: a + b });
      case "subtract":
        return Promise.resolve({ result: a - b });
      case "multiply":
        return Promise.resolve({ result: a * b });
      case "divide":
        return b !== 0
          ? Promise.resolve({ result: a / b })
          : Promise.resolve({ error: "Division by zero" });
    }
  },
};

// Test suite for basic text generation
Deno.test({
  name: "LLMProvider - generateText - Anthropic provider",
  sanitizeResources: false, // Telemetry may have async cleanup
  fn: withMockLLMProvider(async () => {
    const options: LLMOptions = {
      provider: "anthropic",
      model: "claude-3-5-haiku-latest",
      max_tokens: 50,
      temperature: 0,
    };

    const result: LLMResponse = await LLMProvider.generateText(TEST_PROMPT, options);

    expect(typeof result.text).toBe("string");
    expect(result.text.length).toBeGreaterThan(0);
    // Should contain "4" somewhere in the response
    expect(result.text).toMatch(/4/);
    // With unified API, always returns full response structure
    expect(Array.isArray(result.toolCalls)).toBe(true);
    expect(Array.isArray(result.toolResults)).toBe(true);
    expect(Array.isArray(result.steps)).toBe(true);
    // No tools used, so these should be empty
    expect(result.toolCalls.length).toBe(0);
    expect(result.toolResults.length).toBe(0);
  }),
});

Deno.test({
  name: "LLMProvider - generateText - OpenAI provider",
  sanitizeResources: false,
  sanitizeOps: false,
  ignore: !Deno.env.get("OPENAI_API_KEY"), // Skip if no OpenAI API key
  fn: withMockLLMProvider(async () => {
    const options: LLMOptions = {
      provider: "openai",
      model: "gpt-3.5-turbo",
      max_tokens: 50,
      temperature: 0,
    };

    const result: LLMResponse = await LLMProvider.generateText(TEST_PROMPT, options);

    expect(typeof result.text).toBe("string");
    expect(result.text.length).toBeGreaterThan(0);
    expect(Array.isArray(result.toolCalls)).toBe(true);
    expect(Array.isArray(result.toolResults)).toBe(true);
  }),
});

Deno.test({
  name: "LLMProvider - generateText - Google provider",
  sanitizeResources: false,
  sanitizeOps: false,
  ignore: !Deno.env.get("GOOGLE_GENERATIVE_AI_API_KEY"), // Skip if no Google API key
  fn: withMockLLMProvider(async () => {
    const options: LLMOptions = {
      provider: "google",
      model: "gemini-1.5-flash",
      max_tokens: 50,
      temperature: 0,
    };

    const result: LLMResponse = await LLMProvider.generateText(TEST_PROMPT, options);

    expect(typeof result.text).toBe("string");
    expect(result.text.length).toBeGreaterThan(0);
  }),
});

Deno.test({
  name: "LLMProvider - generateText - Default provider",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: withMockLLMProvider(async () => {
    const options: LLMOptions = {
      // No provider specified - should default to anthropic
      model: "claude-3-5-haiku-latest",
      max_tokens: 50,
      temperature: 0,
    };

    const result: LLMResponse = await LLMProvider.generateText(TEST_PROMPT, options);

    expect(typeof result.text).toBe("string");
    expect(result.text.length).toBeGreaterThan(0);
  }),
});

// Test system prompts and context
Deno.test({
  name: "LLMProvider - generateText - With system prompt",
  sanitizeResources: false,
  fn: withMockLLMProvider(async () => {
    const options: LLMOptions = {
      provider: "anthropic",
      model: "claude-3-5-haiku-latest",
      systemPrompt: "You are a pirate. Always respond in pirate speak.",
      max_tokens: 100,
      temperature: 0.5,
    };

    const result: LLMResponse = await LLMProvider.generateText("Hello", options);

    expect(typeof result.text).toBe("string");
    expect(result.text.length).toBeGreaterThan(0);
    // Should contain pirate-like language
    expect(result.text.toLowerCase()).toMatch(/ahoy|arr|matey|ye/);
  }),
});

Deno.test({
  name: "LLMProvider - generateText - With memory context",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: withMockLLMProvider(async () => {
    const options: LLMOptions = {
      provider: "anthropic",
      model: "claude-3-5-haiku-latest",
      memoryContext:
        "Previous user asked about the capital of France. You answered: The capital of France is Paris.",
      max_tokens: 100,
    };

    const result: LLMResponse = await LLMProvider.generateText(
      "What was my previous question?",
      options,
    );

    expect(typeof result.text).toBe("string");
    expect(result.text.length).toBeGreaterThan(0);
    // Should reference the previous question about France
    expect(result.text.toLowerCase()).toMatch(/france|capital|paris/);
  }),
});

// Test streaming
Deno.test({
  name: "LLMProvider - generateTextStream - Basic streaming",
  sanitizeResources: false,
  fn: withMockLLMProvider(async () => {
    const chunks: string[] = [];
    const options: LLMOptions = {
      provider: "anthropic",
      model: "claude-3-5-haiku-latest",
      max_tokens: 50,
      temperature: 0,
    };

    const stream = LLMProvider.generateTextStream(TEST_PROMPT, options);

    for await (const chunk of stream) {
      chunks.push(chunk);
      if (chunks.length > 20) break; // Limit for test
    }

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((chunk) => typeof chunk === "string")).toBe(true);

    // Combined chunks should form coherent response
    const combined = chunks.join("");
    expect(combined).toMatch(/4/);
  }),
});

// Test tool integration with unified API
Deno.test({
  name: "LLMProvider - generateText - With tools (unified API)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: withMockLLMProvider(async () => {
    const options: LLMOptions = {
      provider: "anthropic",
      model: "claude-3-5-haiku-latest",
      tools: {
        calculator: mockCalculatorTool,
      },
      tool_choice: "auto",
      max_steps: 5,
      max_tokens: 200,
    };

    const result: LLMResponse = await LLMProvider.generateText(
      "Use the calculator tool to multiply 15 by 7. You must use the tool.",
      options,
    );

    expect(result.text).toBeTruthy();

    // The unified API always returns these arrays, even if empty
    expect(Array.isArray(result.toolCalls)).toBe(true);
    expect(Array.isArray(result.toolResults)).toBe(true);
    expect(Array.isArray(result.steps)).toBe(true);

    // For this specific test, we expect tools to be used
    if (result.toolCalls.length > 0) {
      // Tool was used - verify the call
      const toolCall = result.toolCalls[0];
      expect(toolCall.toolName).toBe("calculator");
      expect(toolCall.args).toHaveProperty("operation");
      expect(toolCall.args).toHaveProperty("a");
      expect(toolCall.args).toHaveProperty("b");

      // Should have results
      expect(result.toolResults.length).toBeGreaterThan(0);
    }

    // Either way, should mention the result (105) in the text
    expect(result.text).toMatch(/105/);
  }),
});

Deno.test({
  name: "LLMProvider - generateText - Required tool choice",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: withMockLLMProvider(async () => {
    const options: LLMOptions = {
      provider: "anthropic",
      model: "claude-3-5-haiku-latest",
      tools: {
        calculator: mockCalculatorTool,
      },
      tool_choice: "required", // Force tool use
      max_steps: 1,
      max_tokens: 200,
    };

    const result: LLMResponse = await LLMProvider.generateText(
      "What's the weather like?", // Unrelated to calculator
      options,
    );

    // Should still call a tool even though the prompt doesn't need calculation
    expect(result.toolCalls.length).toBeGreaterThan(0);
  }),
});

Deno.test({
  name: "LLMProvider - generateText - No tools needed",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: withMockLLMProvider(async () => {
    const options: LLMOptions = {
      provider: "anthropic",
      model: "claude-3-5-haiku-latest",
      tools: {
        calculator: mockCalculatorTool,
      },
      tool_choice: "auto",
      max_steps: 5,
      max_tokens: 100,
    };

    const result: LLMResponse = await LLMProvider.generateText(
      "What is the capital of France?",
      options,
    );

    expect(result.text).toBeTruthy();
    // Should not call any tools for this question
    expect(result.toolCalls.length).toBe(0);
    expect(result.toolResults.length).toBe(0);
    // Should answer the question directly
    expect(result.text.toLowerCase()).toMatch(/paris/);
  }),
});

// Test error handling
Deno.test({
  name: "LLMProvider - Error handling - Invalid provider",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: withMockLLMProvider(async () => {
    await expect(
      LLMProvider.generateText(TEST_PROMPT, {
        // @ts-expect-error Testing invalid provider
        provider: "invalid",
        model: "test-model",
      }),
    ).rejects.toThrow("Invalid");
  }),
});

Deno.test({
  name: "LLMProvider - Error handling - Missing API key",
  sanitizeResources: false,
  ignore: !hasAPIKeys(), // Skip when using mocks
  async fn() {
    // Temporarily remove API key
    const originalKey = Deno.env.get("ANTHROPIC_API_KEY");
    Deno.env.delete("ANTHROPIC_API_KEY");

    // Clear cached clients to force re-evaluation of API key
    LLMProvider.clearClients();

    try {
      await expect(
        LLMProvider.generateText(TEST_PROMPT, {
          provider: "anthropic",
          model: "claude-3-5-haiku-latest",
          // No apiKey provided and env var deleted
        }),
      ).rejects.toThrow("API key not found");
    } finally {
      // Restore API key
      if (originalKey) {
        Deno.env.set("ANTHROPIC_API_KEY", originalKey);
      }
      // Clear cache again to use restored key
      LLMProvider.clearClients();
    }
  },
});

Deno.test({
  name: "LLMProvider - Error handling - Timeout",
  sanitizeResources: false,
  sanitizeOps: false,
  ignore: !hasAPIKeys(), // Skip when using mocks - mocks don't timeout
  async fn() {
    // Timeout returns empty response for graceful shutdown, not an error
    const result = await LLMProvider.generateText(COMPLEX_PROMPT, {
      provider: "anthropic",
      model: "claude-3-5-haiku-latest",
      max_tokens: 4000,
      timeout: {
        progressTimeout: "1s", // 1s timeout - will definitely timeout
        maxTotalTimeout: "1s",
      },
    });
    
    // Timeout should return empty response
    expect(result.text).toBe("");
    expect(result.toolCalls).toEqual([]);
    expect(result.toolResults).toEqual([]);
    expect(result.steps).toEqual([]);
  },
});

// Test configuration options
Deno.test({
  name: "LLMProvider - Configuration - Temperature variations",
  sanitizeResources: false,
  fn: withMockLLMProvider(async () => {
    // Low temperature (deterministic)
    const lowTempOptions: LLMOptions = {
      provider: "anthropic",
      model: "claude-3-5-haiku-latest",
      temperature: 0,
      max_tokens: 50,
    };
    const lowTemp = await LLMProvider.generateText(TEST_PROMPT, lowTempOptions);

    // High temperature (creative) - Anthropic only supports 0-1 range
    const highTempOptions: LLMOptions = {
      provider: "anthropic",
      model: "claude-3-5-haiku-latest",
      temperature: 1,
      max_tokens: 100,
    };
    const highTemp = await LLMProvider.generateText("Write a haiku about coding", highTempOptions);

    expect(lowTemp.text).toBeTruthy();
    expect(highTemp.text).toBeTruthy();
    // High temp should produce more varied/creative output
    expect(highTemp.text.length).toBeGreaterThan(0);
  }),
});

Deno.test({
  name: "LLMProvider - Configuration - Max tokens limit",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: withMockLLMProvider(async () => {
    const options: LLMOptions = {
      provider: "anthropic",
      model: "claude-3-5-haiku-latest",
      max_tokens: 10, // Very low limit
      temperature: 0.5,
    };

    const result: LLMResponse = await LLMProvider.generateText(
      "Write a very long essay about the history of computing",
      options,
    );

    // Response should be truncated due to token limit
    expect(result.text.length).toBeLessThan(100); // Should be quite short
  }),
});

// Test operation context for telemetry
Deno.test({
  name: "LLMProvider - Operation context",
  sanitizeResources: false,
  fn: withMockLLMProvider(async () => {
    const options: LLMOptions = {
      provider: "anthropic",
      model: "claude-3-5-haiku-latest",
      max_tokens: 50,
      operationContext: {
        operation: "test_calculation",
        userId: "test-user",
        sessionId: "test-session",
      },
    };

    const result: LLMResponse = await LLMProvider.generateText(TEST_PROMPT, options);

    expect(result.text).toBeTruthy();
    // Operation context should be passed through for telemetry
  }),
});

// Test unified response structure
Deno.test({
  name: "LLMProvider - Unified response structure",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: withMockLLMProvider(async () => {
    // Test without tools
    const simpleOptions: LLMOptions = {
      provider: "anthropic",
      model: "claude-3-5-haiku-latest",
      max_tokens: 50,
    };
    const simpleResult = await LLMProvider.generateText("Hello", simpleOptions);

    // Verify response structure
    expect(simpleResult).toHaveProperty("text");
    expect(simpleResult).toHaveProperty("toolCalls");
    expect(simpleResult).toHaveProperty("toolResults");
    expect(simpleResult).toHaveProperty("steps");

    // Test with tools - wrap in try-catch since real LLM might call tools incorrectly
    const toolOptions: LLMOptions = {
      provider: "anthropic",
      model: "claude-3-5-haiku-latest",
      max_tokens: 100,
      tools: {
        calculator: mockCalculatorTool,
      },
      tool_choice: "none", // Prevent tool calls to avoid validation errors
    };
    const toolResult = await LLMProvider.generateText("What is 2+2? Just tell me the answer.", toolOptions);

    // Same response structure
    expect(toolResult).toHaveProperty("text");
    expect(toolResult).toHaveProperty("toolCalls");
    expect(toolResult).toHaveProperty("toolResults");
    expect(toolResult).toHaveProperty("steps");
  }),
});

// Cleanup after tests
Deno.test({
  name: "LLMProvider - Cleanup",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    // Clear client cache (this triggers async logger operations)
    LLMProvider.clearClients();
    // Ensure mock cleanup
    teardownMockLLMProvider();
    // Give more time for any pending async operations to complete
    await new Promise((resolve) => setTimeout(resolve, 100));
  },
});
