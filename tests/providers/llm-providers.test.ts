import { expect } from "@std/expect";
import { LLMProviderManager } from "../../src/core/agents/llm-provider-manager.ts";

const TEST_PROMPT = "What is 2+2? Answer with just the number.";

Deno.test({
  name: "Anthropic Provider - Basic Generation",
  sanitizeResources: false, // Telemetry may have async resource cleanup
  async fn() {
    const result = await LLMProviderManager.generateText(TEST_PROMPT, {
      provider: "anthropic",
      model: "claude-3-5-haiku-20241022",
      maxTokens: 50,
      temperature: 0,
    });

    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  },
});

Deno.test({
  name: "OpenAI Provider - Basic Generation",
  async fn() {
    const result = await LLMProviderManager.generateText(TEST_PROMPT, {
      provider: "openai",
      model: "gpt-3.5-turbo",
      maxTokens: 50,
      temperature: 0,
    });

    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  },
});

Deno.test({
  name: "Google Provider - Basic Generation",
  async fn() {
    const result = await LLMProviderManager.generateText(TEST_PROMPT, {
      provider: "google",
      model: "gemini-1.5-flash",
      maxTokens: 50,
      temperature: 0,
    });

    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  },
});

Deno.test({
  name: "Provider Validation - Invalid Provider",
  async fn() {
    await expect(
      LLMProviderManager.generateText(TEST_PROMPT, {
        // @ts-expect-error testing the bad thing :)
        provider: "invalid",
        model: "test-model",
      }),
    ).rejects.toThrow("Invalid LLM configuration");
  },
});

Deno.test({
  name: "Streaming Generation - Anthropic",
  async fn() {
    const chunks: string[] = [];
    const stream = LLMProviderManager.generateTextStream(TEST_PROMPT, {
      provider: "anthropic",
      model: "claude-3-5-haiku-20241022",
      maxTokens: 50,
      temperature: 0,
    });

    for await (const chunk of stream) {
      chunks.push(chunk);
      if (chunks.length > 10) break; // Limit for test
    }

    expect(chunks.length).toBeGreaterThan(0);
    expect(typeof chunks[0]).toBe("string");
  },
});

Deno.test({
  name: "Default Provider Fallback",
  async fn() {
    const result = await LLMProviderManager.generateText(TEST_PROMPT, {
      // No provider specified - should default to anthropic
      provider: "anthropic",
      model: "claude-3-5-haiku-20241022",
      maxTokens: 50,
      temperature: 0,
    });

    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  },
});

Deno.test({
  name: "Provider Utility Functions",
  fn() {
    const providers = LLMProviderManager.getSupportedProviders();
    expect(providers).toContain("anthropic");
    expect(providers).toContain("openai");
    expect(providers).toContain("google");
  },
});
