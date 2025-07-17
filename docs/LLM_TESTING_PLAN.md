# LLM Testing Without API Keys - Implementation Plan

## Overview

This document outlines a comprehensive plan to implement LLM testing capabilities that do not
require real API keys, addressing the current issue where integration tests depend on external LLM
providers (Anthropic, OpenAI, Google) and fail without valid API keys.

## Current State Analysis

### Problems Identified

1. **Integration tests require real API keys** (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
   `GOOGLE_API_KEY`)
2. **Tests fail in CI/CD** without proper API key configuration
3. **Slow test execution** due to network calls to external LLM providers
4. **Test reliability issues** due to external service dependencies
5. **Cost implications** of running tests against paid LLM APIs

### Current LLM-Dependent Tests

- `packages/core/test/llm-provider.test.ts` - Comprehensive LLMProvider tests
- `tests/integration/reasoning-llm-simple.test.ts` - ReasoningMachine integration tests
- `tests/integration/reasoning-llm-tools.test.ts` - ReasoningMachine with tools
- Various agent tests that depend on LLM providers

## AI SDK Built-in Testing Tools Discovery

### Key Finding: AI SDK v4.0.7 Provides Native Testing Support

The Vercel AI SDK includes comprehensive testing utilities that significantly simplify our
implementation:

#### **Built-in Mock Providers**

- `MockLanguageModelV1` - Mock language model for text generation
- `MockEmbeddingModelV1` - Mock embedding model

#### **Test Helpers**

- `mockId()` - Provides incrementing integer IDs
- `mockValues()` - Iterates over predefined array values
- `simulateReadableStream()` - Simulates readable streams with delays

#### **Benefits for Atlas**

- **Reduced implementation complexity** - Leverage official AI SDK testing tools
- **Better compatibility** - Maintains compatibility with AI SDK updates
- **Proper mock structure** - AI SDK expects specific mock implementations
- **Official support** - Documentation and examples provided by Vercel

#### **Example Usage**

```typescript
import { generateText, MockLanguageModelV1 } from "ai";

const result = await generateText({
  model: new MockLanguageModelV1({
    doGenerate: async () => ({
      text: `Hello, world!`,
      finishReason: "stop",
      usage: { promptTokens: 10, completionTokens: 20 },
    }),
  }),
  prompt: "Hello, test!",
});
```

## Implementation Plan

### Phase 1: Analysis & Architecture Design

#### 1.1 Current State Analysis

- **Audit existing LLM-dependent tests** in `packages/core/test/llm-provider.test.ts`
- **Identify all components** that depend on LLM providers (agents, reasoning machines, supervisors)
- **Map API key dependencies** across the codebase
- **Analyze test patterns** in integration tests requiring real API calls
- **Research AI SDK built-in testing utilities** and integration patterns

#### 1.2 Design MockLLMProvider Architecture (Updated)

- **Leverage AI SDK's MockLanguageModelV1** as the foundation
- **Extend with Atlas-specific functionality**: pattern matching, tool calling simulation
- **Support all LLMProvider methods**: `generateText`, `generateTextStream`, `clearClients`
- **Handle all provider types**: Anthropic, OpenAI, Google
- **Integrate with existing Atlas mock patterns** in `tests/fixtures/mocks.ts`

### Phase 2: Core Implementation

#### 2.1 Create AtlasMockLLMProvider Class (Updated)

**File**: `src/testing/atlas-mock-llm-provider.ts`

```typescript
import { generateText, MockLanguageModelV1, streamText } from "ai";
import type { LLMOptions, LLMResponse } from "../core/llm-provider.ts";

interface AtlasMockConfig {
  defaultResponse: string;
  patternResponses: Map<string, string>;
  streamResponses: Map<string, string[]>;
  toolCallResponses: Map<string, any[]>;
}

export class AtlasMockLLMProvider {
  private static config: AtlasMockConfig = {
    defaultResponse: "Mock LLM response",
    patternResponses: new Map(),
    streamResponses: new Map(),
    toolCallResponses: new Map(),
  };

  /**
   * Creates a mock language model using AI SDK's MockLanguageModelV1
   */
  static createMockModel(responses?: Record<string, string>) {
    if (responses) {
      for (const [pattern, response] of Object.entries(responses)) {
        this.config.patternResponses.set(pattern, response);
      }
    }

    return new MockLanguageModelV1({
      doGenerate: async ({ prompt, tools }) => {
        const promptText = Array.isArray(prompt)
          ? prompt.map((p) => typeof p === "string" ? p : p.content).join(" ")
          : typeof prompt === "string"
          ? prompt
          : prompt.content;

        // Pattern matching for specific prompts
        for (const [pattern, response] of this.config.patternResponses) {
          if (promptText.includes(pattern)) {
            return {
              text: response,
              finishReason: "stop",
              usage: { promptTokens: 10, completionTokens: 20 },
            };
          }
        }

        // Handle tool calls
        if (tools && Object.keys(tools).length > 0) {
          const toolName = Object.keys(tools)[0];
          return {
            text: "Used tool to process request",
            finishReason: "tool-calls",
            usage: { promptTokens: 15, completionTokens: 25 },
            toolCalls: [{
              toolCallId: "mock-tool-call-123",
              toolName,
              args: { operation: "add", a: 2, b: 2 },
            }],
          };
        }

        return {
          text: this.config.defaultResponse,
          finishReason: "stop",
          usage: { promptTokens: 10, completionTokens: 20 },
        };
      },

      doStream: async ({ prompt }) => {
        const promptText = Array.isArray(prompt)
          ? prompt.map((p) => typeof p === "string" ? p : p.content).join(" ")
          : typeof prompt === "string"
          ? prompt
          : prompt.content;

        const chunks = this.config.streamResponses.get(promptText) ||
          ["Mock", " streaming", " response"];

        return {
          stream: (async function* () {
            for (const chunk of chunks) {
              yield {
                type: "text-delta",
                textDelta: chunk,
                usage: { promptTokens: 5, completionTokens: 5 },
              };
            }
            yield {
              type: "finish",
              finishReason: "stop",
              usage: { promptTokens: 10, completionTokens: 20 },
            };
          })(),
          rawCall: { rawPrompt: promptText, rawSettings: {} },
        };
      },
    });
  }

  /**
   * Atlas-specific generateText wrapper using AI SDK's generateText
   */
  static async generateText(userPrompt: string, options: LLMOptions): Promise<LLMResponse> {
    const mockModel = this.createMockModel();

    const result = await generateText({
      model: mockModel,
      prompt: userPrompt,
      tools: options.tools,
      maxTokens: options.max_tokens,
      temperature: options.temperature,
    });

    return {
      text: result.text,
      toolCalls: result.toolCalls || [],
      toolResults: result.toolResults || [],
      steps: result.steps || [],
    };
  }

  /**
   * Atlas-specific streaming wrapper using AI SDK's streamText
   */
  static async *generateTextStream(
    userPrompt: string,
    options: LLMOptions,
  ): AsyncIterableIterator<string> {
    const mockModel = this.createMockModel();

    const stream = await streamText({
      model: mockModel,
      prompt: userPrompt,
      maxTokens: options.max_tokens,
      temperature: options.temperature,
    });

    for await (const chunk of stream.textStream) {
      yield chunk;
    }
  }

  static clearClients(): void {
    // Mock implementation - no actual clients to clear
  }

  // Configuration methods
  static setMockResponse(pattern: string, response: string): void {
    this.config.patternResponses.set(pattern, response);
  }

  static setMockStreamResponse(pattern: string, chunks: string[]): void {
    this.config.streamResponses.set(pattern, chunks);
  }

  static setDefaultResponse(response: string): void {
    this.config.defaultResponse = response;
  }

  static reset(): void {
    this.config.patternResponses.clear();
    this.config.streamResponses.clear();
    this.config.toolCallResponses.clear();
  }
}
```

#### 2.2 Create LLM Testing Utilities (Updated)

**File**: `src/testing/llm-test-helpers.ts`

```typescript
import { AtlasMockLLMProvider } from "./atlas-mock-llm-provider.ts";
import { LLMProvider } from "../core/llm-provider.ts";
import type { LLMOptions, LLMResponse } from "../core/llm-provider.ts";
import { createMockAgent } from "../tests/fixtures/mocks.ts";

export function createMockLLMResponse(
  text: string,
  toolCalls: any[] = [],
  toolResults: any[] = [],
  steps: any[] = [],
): LLMResponse {
  return {
    text,
    toolCalls,
    toolResults,
    steps,
  };
}

export function createMockLLMAgent(
  id: string,
  responses: Record<string, string>,
): IWorkspaceAgent {
  const baseAgent = createMockAgent(id);

  baseAgent.invoke = async (message: string): Promise<string> => {
    for (const [pattern, response] of Object.entries(responses)) {
      if (message.includes(pattern)) {
        return response;
      }
    }
    return `Mock LLM response to: ${message}`;
  };

  return baseAgent;
}

/**
 * Setup LLM testing using AI SDK's MockLanguageModelV1
 */
export function setupLLMTesting(): void {
  // Replace LLMProvider methods with Atlas mock implementations
  const originalGenerateText = LLMProvider.generateText;
  const originalGenerateTextStream = LLMProvider.generateTextStream;
  const originalClearClients = LLMProvider.clearClients;

  LLMProvider.generateText = AtlasMockLLMProvider.generateText;
  LLMProvider.generateTextStream = AtlasMockLLMProvider.generateTextStream;
  LLMProvider.clearClients = AtlasMockLLMProvider.clearClients;

  // Store originals for restoration
  (globalThis as any).__originalLLMProvider = {
    generateText: originalGenerateText,
    generateTextStream: originalGenerateTextStream,
    clearClients: originalClearClients,
  };
}

export function teardownLLMTesting(): void {
  // Restore original LLMProvider methods
  if ((globalThis as any).__originalLLMProvider) {
    const original = (globalThis as any).__originalLLMProvider;
    LLMProvider.generateText = original.generateText;
    LLMProvider.generateTextStream = original.generateTextStream;
    LLMProvider.clearClients = original.clearClients;
    delete (globalThis as any).__originalLLMProvider;
  }

  // Reset mock state
  AtlasMockLLMProvider.reset();
}

export function mockLLMProvider(responses: Record<string, string>): void {
  for (const [pattern, response] of Object.entries(responses)) {
    AtlasMockLLMProvider.setMockResponse(pattern, response);
  }
}

export function createMockReasoningMachine(responses: Record<string, string>) {
  return {
    async generateThinking(prompt: string): Promise<string> {
      for (const [pattern, response] of Object.entries(responses)) {
        if (prompt.includes(pattern)) {
          return response;
        }
      }
      return "Mock reasoning response";
    },
  };
}

/**
 * Create a mock model directly using AI SDK
 */
export function createMockModel(responses?: Record<string, string>) {
  return AtlasMockLLMProvider.createMockModel(responses);
}

/**
 * Test helper for creating Atlas agents with mocked LLM
 */
export function createTestAgentWithMockLLM(
  id: string,
  responses: Record<string, string>,
): IWorkspaceAgent {
  const agent = createMockAgent(id);

  // Override invoke to use our mock LLM
  agent.invoke = async (message: string): Promise<string> => {
    const mockResponse = await AtlasMockLLMProvider.generateText(message, {
      provider: "anthropic",
      model: "claude-3-5-haiku-latest",
    });
    return mockResponse.text;
  };

  // Configure responses
  mockLLMProvider(responses);

  return agent;
}
```

#### 2.3 Test Configuration System

**File**: `src/testing/test-config.ts`

```typescript
export interface LLMTestConfig {
  useMocks: boolean;
  mockResponses: Record<string, LLMResponse>;
  fallbackToReal: boolean;
  enableLogging: boolean;
}

export class LLMTestConfiguration {
  private static config: LLMTestConfig = {
    useMocks: true,
    mockResponses: {},
    fallbackToReal: false,
    enableLogging: false,
  };

  static configure(config: Partial<LLMTestConfig>): void {
    this.config = { ...this.config, ...config };
  }

  static shouldUseMocks(): boolean {
    return this.config.useMocks || !this.hasRealAPIKeys();
  }

  static hasRealAPIKeys(): boolean {
    return !!(
      Deno.env.get("ANTHROPIC_API_KEY") ||
      Deno.env.get("OPENAI_API_KEY") ||
      Deno.env.get("GOOGLE_API_KEY")
    );
  }

  static getConfig(): LLMTestConfig {
    return { ...this.config };
  }

  static reset(): void {
    this.config = {
      useMocks: true,
      mockResponses: {},
      fallbackToReal: false,
      enableLogging: false,
    };
  }
}
```

### Phase 3: Integration & Refactoring

#### 3.1 Dependency Injection Pattern

Update LLM-dependent classes to accept provider as parameter:

```typescript
// Before
class Agent {
  async process(input: string): Promise<string> {
    const response = await LLMProvider.generateText(input, options);
    return response.text;
  }
}

// After
class Agent {
  constructor(private llmProvider: typeof LLMProvider = LLMProvider) {}

  async process(input: string): Promise<string> {
    const response = await this.llmProvider.generateText(input, options);
    return response.text;
  }
}

// Factory function
export function createAgent(useMock: boolean = false): Agent {
  const provider = useMock ? MockLLMProvider : LLMProvider;
  return new Agent(provider as any);
}
```

#### 3.2 Convert Integration Tests

**Example**: Update `reasoning-llm-simple.test.ts`

```typescript
import {
  mockLLMProvider,
  setupLLMTesting,
  teardownLLMTesting,
} from "../src/testing/llm-test-helpers.ts";

Deno.test({
  name: "ReasoningMachine - basic reasoning with mocked LLM",
  async fn() {
    setupLLMTesting();

    try {
      // Configure mock responses
      mockLLMProvider({
        "25 + 17": {
          text: "I need to calculate 25 + 17. The answer is 42.",
          toolCalls: [],
          toolResults: [],
          steps: [],
        },
      });

      const machine = new ReasoningMachine();
      const result = await machine.generateThinking("What is 25 + 17?");

      expect(result).toContain("42");
    } finally {
      teardownLLMTesting();
    }
  },
});

// Keep integration test for real API (optional)
Deno.test({
  name: "ReasoningMachine - real LLM integration",
  ignore: !Deno.env.get("ANTHROPIC_API_KEY"),
  async fn() {
    const machine = new ReasoningMachine();
    const result = await machine.generateThinking("What is 25 + 17?");

    expect(result).toContain("42");
  },
});
```

#### 3.3 Update Test Infrastructure

Extend existing `tests/fixtures/mocks.ts`:

```typescript
export function createMockLLMWorkspace(responses: Record<string, string>): IWorkspace {
  const workspace = createMockWorkspace();

  // Override agents to use mocked LLM responses
  workspace.agents = {
    "llm-agent": createMockLLMAgent("llm-agent", responses),
  };

  return workspace;
}
```

### Phase 4: Testing & Documentation

#### 4.1 Comprehensive Test Examples

**Unit Tests with AI SDK Mocking**:

```typescript
import {
  mockLLMProvider,
  setupLLMTesting,
  teardownLLMTesting,
} from "../src/testing/llm-test-helpers.ts";

Deno.test("Agent processes math input with AI SDK mocked LLM", async () => {
  setupLLMTesting();

  try {
    // Configure mock responses using AI SDK's MockLanguageModelV1
    mockLLMProvider({
      "calculate": "The result is 42",
    });

    const agent = createAgent(true);
    const result = await agent.process("calculate 2+2");

    expect(result).toContain("42");
  } finally {
    teardownLLMTesting();
  }
});

// Direct AI SDK usage example
Deno.test("Direct AI SDK mock usage", async () => {
  const { generateText } = await import("ai");
  const { createMockModel } = await import("../src/testing/llm-test-helpers.ts");

  const mockModel = createMockModel({
    "What is 2+2?": "The answer is 4",
  });

  const result = await generateText({
    model: mockModel,
    prompt: "What is 2+2?",
  });

  expect(result.text).toBe("The answer is 4");
});
```

**Integration Tests with Real API**:

```typescript
Deno.test({
  name: "Agent with real LLM integration",
  ignore: !Deno.env.get("ANTHROPIC_API_KEY"),
  async fn() {
    const agent = createAgent(false);
    const result = await agent.process("What is 2+2?");

    expect(result).toMatch(/4/);
  },
});
```

#### 4.2 Performance Testing

```typescript
Deno.test("AI SDK MockLLMProvider performance", async () => {
  setupLLMTesting();

  try {
    const startTime = performance.now();

    // Run 100 mock LLM calls using AI SDK's MockLanguageModelV1
    for (let i = 0; i < 100; i++) {
      await AtlasMockLLMProvider.generateText("test prompt", {
        provider: "anthropic",
        model: "claude-3-5-haiku-latest",
      });
    }

    const endTime = performance.now();
    const duration = endTime - startTime;

    // Should complete in under 100ms (AI SDK mocks are very fast)
    expect(duration).toBeLessThan(100);
  } finally {
    teardownLLMTesting();
  }
});

// Test streaming performance
Deno.test("AI SDK streaming mock performance", async () => {
  setupLLMTesting();

  try {
    const startTime = performance.now();

    // Test streaming performance
    const stream = AtlasMockLLMProvider.generateTextStream("test prompt", {
      provider: "anthropic",
      model: "claude-3-5-haiku-latest",
    });

    let chunks = 0;
    for await (const chunk of stream) {
      chunks++;
      if (chunks > 10) break; // Limit for test
    }

    const endTime = performance.now();
    const duration = endTime - startTime;

    // Streaming should be very fast with mocks
    expect(duration).toBeLessThan(50);
    expect(chunks).toBeGreaterThan(0);
  } finally {
    teardownLLMTesting();
  }
});
```

### Phase 5: Validation & Rollout

#### 5.1 Migration Strategy

1. **Gradual rollout** - Start with new tests using mocks
2. **Parallel testing** - Run both mocked and real API tests temporarily
3. **Performance monitoring** - Track test execution times
4. **Backward compatibility** - Ensure existing tests continue to work

#### 5.2 CI/CD Integration

```yaml
# .github/workflows/test.yml
name: Test Suite

on: [push, pull_request]

jobs:
  test-unit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: denoland/setup-deno@v1
      - name: Run unit tests (with mocks)
        run: deno test --allow-all tests/unit/
        env:
          ATLAS_USE_LLM_MOCKS: "true"

  test-integration:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: denoland/setup-deno@v1
      - name: Run integration tests (real API)
        run: deno test --allow-all tests/integration/
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          ATLAS_USE_LLM_MOCKS: "false"
```

## Implementation Timeline

### Week 1: Foundation ✅

- [x] Analyze current architecture
- [x] Design MockLLMProvider interface
- [x] Create basic mock implementation

### Week 2: Core Development 🔄

- [ ] Implement AtlasMockLLMProvider using AI SDK's MockLanguageModelV1
- [ ] Create testing utilities leveraging AI SDK test helpers
- [ ] Set up test configuration system

### Week 3: Integration 🔄

- [ ] Implement dependency injection
- [ ] Convert key integration tests
- [ ] Update test infrastructure

### Week 4: Testing & Documentation 🔄

- [ ] Comprehensive testing
- [ ] Performance validation
- [ ] Documentation creation

### Week 5: Validation & Rollout 🔄

- [ ] Full test suite validation
- [ ] CI/CD pipeline updates
- [ ] Team training materials

## Success Metrics

- **Test Speed**: 10x faster test execution without API calls (AI SDK mocks are extremely fast)
- **Reliability**: 100% test pass rate without API keys
- **Coverage**: All LLM-dependent components mockable using AI SDK patterns
- **Maintainability**: Clear patterns for new LLM tests leveraging official AI SDK tools
- **Backward Compatibility**: Existing tests continue to work
- **AI SDK Alignment**: Full compatibility with AI SDK v4.0.7 testing utilities

## Risk Mitigation

- **Mock accuracy**: Regularly validate mocks against real API responses
- **Test isolation**: Ensure mocks don't interfere with each other (AI SDK handles this well)
- **Environment handling**: Robust configuration for different test environments
- **Performance**: Monitor test suite performance impact (AI SDK mocks are very fast)
- **AI SDK compatibility**: Track AI SDK updates and adjust mocks accordingly
- **Tool calling**: Ensure AI SDK's mock tool calling matches real behavior

## Best Practices

### For Test Authors

1. **Always use AI SDK mocks for unit tests** - Fast, reliable, no API keys needed
2. **Use real APIs sparingly** - Only for critical integration tests
3. **Configure meaningful responses** - Match expected LLM behavior patterns
4. **Clean up after tests** - Use `teardownLLMTesting()` in finally blocks
5. **Test both paths** - Mock for speed, real API for validation
6. **Leverage AI SDK patterns** - Use `MockLanguageModelV1` for consistency

### For Mock Configuration

1. **Pattern-based responses** - Use `mockLLMProvider()` for specific prompts
2. **Realistic responses** - Mock responses should match real LLM behavior
3. **Tool call simulation** - Test agent tool usage with AI SDK's mock tool calling
4. **Error simulation** - Test error handling with mock failures
5. **AI SDK compatibility** - Ensure mocks work with AI SDK's `generateText` and `streamText`

### For CI/CD

1. **Default to mocks** - Fast feedback loops
2. **Optional real API tests** - Separate job with API keys
3. **Environment detection** - Automatically choose mock vs real
4. **Performance monitoring** - Track test execution times

## Summary

This updated plan leverages **AI SDK v4.0.7's built-in testing utilities** to create a robust LLM
testing framework:

### Key Advantages of AI SDK Integration

1. **Official Support** - Uses Vercel's officially supported `MockLanguageModelV1`
2. **Reduced Complexity** - Less custom implementation, more standard patterns
3. **Better Compatibility** - Native AI SDK integration ensures future compatibility
4. **Comprehensive Coverage** - Supports text generation, streaming, and tool calling
5. **Performance** - AI SDK mocks are extremely fast and efficient

### Implementation Benefits

- **25% less implementation time** - Leveraging existing AI SDK tools
- **Higher reliability** - Official mocks are well-tested and maintained
- **Better maintainability** - Standard patterns that team can easily understand
- **Future-proof** - Automatic compatibility with AI SDK updates

This comprehensive plan addresses the current API key dependency issues while maintaining high test
quality and providing a clear path for implementation using industry-standard testing tools.
