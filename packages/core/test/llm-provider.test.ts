/**
 * Comprehensive test suite for LLMProvider
 * Tests all methods, providers, and edge cases
 */

import { expect } from "@std/expect";
import { type LLMOptions, LLMProvider, type LLMResponse } from "../src/llm-provider.ts";
import { Tool } from "ai";

// Test constants
const TEST_PROMPT = "What is 2+2? Answer with just the number.";
const COMPLEX_PROMPT = "Explain the concept of recursion in programming.";

// Mock tool for testing - use direct format that works with Anthropic
const mockCalculatorTool: Tool = {
  description: "Perform basic calculations",
  parameters: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        enum: ["add", "subtract", "multiply", "divide"],
        description: "The operation to perform",
      },
      a: { type: "number", description: "First number" },
      b: { type: "number", description: "Second number" },
    },
    required: ["operation", "a", "b"],
  },
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
  async fn() {
    const options: LLMOptions = {
      provider: "anthropic",
      model: "claude-3-5-haiku-20241022",
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
  },
});

Deno.test({
  name: "LLMProvider - generateText - OpenAI provider",
  sanitizeResources: false,
  async fn() {
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
  },
});

Deno.test({
  name: "LLMProvider - generateText - Google provider",
  sanitizeResources: false,
  async fn() {
    const options: LLMOptions = {
      provider: "google",
      model: "gemini-1.5-flash",
      max_tokens: 50,
      temperature: 0,
    };

    const result: LLMResponse = await LLMProvider.generateText(TEST_PROMPT, options);

    expect(typeof result.text).toBe("string");
    expect(result.text.length).toBeGreaterThan(0);
  },
});

Deno.test({
  name: "LLMProvider - generateText - Default provider",
  sanitizeResources: false,
  async fn() {
    const options: LLMOptions = {
      // No provider specified - should default to anthropic
      model: "claude-3-5-haiku-20241022",
      max_tokens: 50,
      temperature: 0,
    };

    const result: LLMResponse = await LLMProvider.generateText(TEST_PROMPT, options);

    expect(typeof result.text).toBe("string");
    expect(result.text.length).toBeGreaterThan(0);
  },
});

// Test system prompts and context
Deno.test({
  name: "LLMProvider - generateText - With system prompt",
  sanitizeResources: false,
  async fn() {
    const options: LLMOptions = {
      provider: "anthropic",
      model: "claude-3-5-haiku-20241022",
      systemPrompt: "You are a pirate. Always respond in pirate speak.",
      max_tokens: 100,
      temperature: 0.5,
    };

    const result: LLMResponse = await LLMProvider.generateText("Hello", options);

    expect(typeof result.text).toBe("string");
    expect(result.text.length).toBeGreaterThan(0);
    // Should contain pirate-like language
    expect(result.text.toLowerCase()).toMatch(/ahoy|arr|matey|ye/);
  },
});

Deno.test({
  name: "LLMProvider - generateText - With memory context",
  sanitizeResources: false,
  async fn() {
    const options: LLMOptions = {
      provider: "anthropic",
      model: "claude-3-5-haiku-20241022",
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
  },
});

// Test streaming
Deno.test({
  name: "LLMProvider - generateTextStream - Basic streaming",
  sanitizeResources: false,
  async fn() {
    const chunks: string[] = [];
    const options: LLMOptions = {
      provider: "anthropic",
      model: "claude-3-5-haiku-20241022",
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
  },
});

// Test tool integration with unified API
Deno.test({
  name: "LLMProvider - generateText - With tools (unified API)",
  sanitizeResources: false,
  async fn() {
    const options: LLMOptions = {
      provider: "anthropic",
      model: "claude-3-5-haiku-20241022",
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
  },
});

Deno.test({
  name: "LLMProvider - generateText - Required tool choice",
  sanitizeResources: false,
  async fn() {
    const options: LLMOptions = {
      provider: "anthropic",
      model: "claude-3-5-haiku-20241022",
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
  },
});

Deno.test({
  name: "LLMProvider - generateText - No tools needed",
  sanitizeResources: false,
  async fn() {
    const options: LLMOptions = {
      provider: "anthropic",
      model: "claude-3-5-haiku-20241022",
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
  },
});

// Test error handling
Deno.test({
  name: "LLMProvider - Error handling - Invalid provider",
  async fn() {
    await expect(
      LLMProvider.generateText(TEST_PROMPT, {
        // @ts-expect-error Testing invalid provider
        provider: "invalid",
        model: "test-model",
      }),
    ).rejects.toThrow("Invalid");
  },
});

Deno.test({
  name: "LLMProvider - Error handling - Missing API key",
  sanitizeResources: false,
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
          model: "claude-3-5-haiku-20241022",
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
  async fn() {
    await expect(
      LLMProvider.generateText(COMPLEX_PROMPT, {
        provider: "anthropic",
        model: "claude-3-5-haiku-20241022",
        max_tokens: 4000,
        timeout: 1, // 1ms timeout - will definitely timeout
      }),
    ).rejects.toThrow(/timed out/);
  },
});

// Test configuration options
Deno.test({
  name: "LLMProvider - Configuration - Temperature variations",
  sanitizeResources: false,
  async fn() {
    // Low temperature (deterministic)
    const lowTempOptions: LLMOptions = {
      provider: "anthropic",
      model: "claude-3-5-haiku-20241022",
      temperature: 0,
      max_tokens: 50,
    };
    const lowTemp = await LLMProvider.generateText(TEST_PROMPT, lowTempOptions);

    // High temperature (creative) - Anthropic only supports 0-1 range
    const highTempOptions: LLMOptions = {
      provider: "anthropic",
      model: "claude-3-5-haiku-20241022",
      temperature: 1,
      max_tokens: 100,
    };
    const highTemp = await LLMProvider.generateText("Write a haiku about coding", highTempOptions);

    expect(lowTemp.text).toBeTruthy();
    expect(highTemp.text).toBeTruthy();
    // High temp should produce more varied/creative output
    expect(highTemp.text.length).toBeGreaterThan(0);
  },
});

Deno.test({
  name: "LLMProvider - Configuration - Max tokens limit",
  sanitizeResources: false,
  async fn() {
    const options: LLMOptions = {
      provider: "anthropic",
      model: "claude-3-5-haiku-20241022",
      max_tokens: 10, // Very low limit
      temperature: 0.5,
    };

    const result: LLMResponse = await LLMProvider.generateText(
      "Write a very long essay about the history of computing",
      options,
    );

    // Response should be truncated due to token limit
    expect(result.text.length).toBeLessThan(100); // Should be quite short
  },
});

// Test operation context for telemetry
Deno.test({
  name: "LLMProvider - Operation context",
  sanitizeResources: false,
  async fn() {
    const options: LLMOptions = {
      provider: "anthropic",
      model: "claude-3-5-haiku-20241022",
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
  },
});

// Test unified response structure
Deno.test({
  name: "LLMProvider - Unified response structure",
  sanitizeResources: false,
  async fn() {
    // Test without tools
    const simpleOptions: LLMOptions = {
      provider: "anthropic",
      model: "claude-3-5-haiku-20241022",
      max_tokens: 50,
    };
    const simpleResult = await LLMProvider.generateText("Hello", simpleOptions);

    // Verify response structure
    expect(simpleResult).toHaveProperty("text");
    expect(simpleResult).toHaveProperty("toolCalls");
    expect(simpleResult).toHaveProperty("toolResults");
    expect(simpleResult).toHaveProperty("steps");

    // Test with tools
    const toolOptions: LLMOptions = {
      provider: "anthropic",
      model: "claude-3-5-haiku-20241022",
      max_tokens: 100,
      tools: {
        calculator: mockCalculatorTool,
      },
    };
    const toolResult = await LLMProvider.generateText("Calculate 2+2", toolOptions);

    // Same response structure
    expect(toolResult).toHaveProperty("text");
    expect(toolResult).toHaveProperty("toolCalls");
    expect(toolResult).toHaveProperty("toolResults");
    expect(toolResult).toHaveProperty("steps");
  },
});

// Cleanup after tests
Deno.test({
  name: "LLMProvider - Cleanup",
  sanitizeResources: false,
  fn() {
    // Clear client cache
    LLMProvider.clearClients();
  },
});
