# Multi-Provider LLM Support - Implementation Summary

## Overview

Atlas now supports multiple LLM providers (Anthropic, OpenAI, Google) through a simplified
architecture that leverages the Vercel AI SDK. This implementation provides a unified interface for
all providers while maintaining type safety and backward compatibility.

## Architecture

### Simplified AI SDK Approach

Instead of building complex provider abstractions, Atlas uses the AI SDK's built-in provider support
with a single `LLMProviderManager` class that handles all provider interactions.

**Key Design Principles:**

- **AI SDK First**: Leverage existing AI SDK patterns instead of custom abstractions
- **Type Safety**: Use TypeScript union types for provider client type safety
- **Explicit Configuration**: Require explicit model specification (no default models)
- **Unified Interface**: Single interface for all providers via AI SDK
- **Runtime Validation**: Let AI SDK and provider APIs handle model validation

## Current Implementation

### LLMProviderManager (`src/core/llm-provider-manager.ts`)

The core class that manages all LLM provider interactions:

```typescript
export class LLMProviderManager {
  private static clients: Map<string, ProviderClient> = new Map();

  static async generateText(
    userPrompt: string,
    options: LLMGenerationOptions & Partial<LLMConfig> = {},
  ): Promise<string>;

  static async *generateTextStream(
    userPrompt: string,
    options: LLMGenerationOptions & Partial<LLMConfig> = {},
  ): AsyncGenerator<string>;

  private static getProviderClient(provider: string, config?: LLMConfig): ProviderClient;
}
```

**Features:**

- **Client Caching**: Provider clients cached by `provider:apiKey` for performance
- **Type Safety**: `ProviderClient` union type for compile-time safety
- **Unified API**: Same interface for all providers via AI SDK
- **Streaming Support**: Native streaming via AI SDK `streamText`

### Type Safety

```typescript
// Union type for provider clients
type ProviderClient = AnthropicProvider | OpenAIProvider | GoogleGenerativeAIProvider;

// Zod validation schemas
const LLMProviderSchema = z.enum(["anthropic", "openai", "google"]);
const LLMConfigSchema = z.object({
  provider: LLMProviderSchema.optional().default("anthropic"),
  model: z.string(), // REQUIRED - no default models
  apiKey: z.string().optional(),
  maxTokens: z.number().positive().optional().default(4000),
  temperature: z.number().min(0).max(2).optional().default(0.7),
  timeout: z.number().positive().optional().default(30000),
});
```

### Provider Support

**Supported Providers:**

- **Anthropic**: Claude models via `@ai-sdk/anthropic`
- **OpenAI**: GPT models via `@ai-sdk/openai`
- **Google**: Gemini models via `@ai-sdk/google`

**Environment Variables:**

- `ANTHROPIC_API_KEY`
- `OPENAI_API_KEY`
- `GOOGLE_GENERATIVE_AI_API_KEY`

## Configuration

### Agent Configuration

**Current Schema:**

```yaml
agents:
  code-reviewer:
    type: "llm"
    provider: "anthropic" # Optional, defaults to "anthropic"
    model: "claude-3-5-sonnet-20241022" # REQUIRED
    temperature: 0.7
    max_tokens: 4000
    prompts:
      system: "You are a code reviewer..."

  doc-writer:
    type: "llm"
    provider: "openai"
    model: "gpt-4o" # REQUIRED
    temperature: 0.8
    max_tokens: 2000

  data-analyst:
    type: "llm"
    provider: "google"
    model: "gemini-1.5-pro" # REQUIRED
    temperature: 0.6
    max_tokens: 8000
```

**Key Changes from Original Plan:**

- Model field is **required** - no default models provided
- Simplified configuration - no complex validation rules
- Runtime model validation via AI SDK

### Backward Compatibility

**Maintained:**

- Default provider remains "anthropic" if not specified
- Existing environment variables (`ANTHROPIC_API_KEY`) still work
- Existing workspace configurations continue working

**Breaking Changes:**

- Model field is now required (previously could rely on defaults)
- No static model validation (relies on runtime validation)

## Usage Examples

### Basic Generation

```typescript
// Anthropic (default provider)
const result1 = await LLMProviderManager.generateText(
  "What is TypeScript?",
  {
    model: "claude-3-5-sonnet-20241022",
    temperature: 0.7,
  },
);

// OpenAI
const result2 = await LLMProviderManager.generateText(
  "Explain async/await",
  {
    provider: "openai",
    model: "gpt-4o",
    temperature: 0.5,
  },
);

// Google
const result3 = await LLMProviderManager.generateText(
  "Compare databases",
  {
    provider: "google",
    model: "gemini-1.5-pro",
    temperature: 0.3,
  },
);
```

### Streaming Generation

```typescript
const stream = LLMProviderManager.generateTextStream(
  "Write a story about AI",
  {
    provider: "anthropic",
    model: "claude-3-5-haiku-20241022",
    maxTokens: 1000,
  },
);

for await (const chunk of stream) {
  process.stdout.write(chunk);
}
```

### With System Prompts and Memory

```typescript
const result = await LLMProviderManager.generateText(
  "Review this code",
  {
    provider: "anthropic",
    model: "claude-3-5-sonnet-20241022",
    systemPrompt: "You are a senior software engineer...",
    memoryContext: "Previous conversation about TypeScript best practices...",
    operationContext: {
      operation: "code_review",
      sessionId: "session-123",
    },
  },
);
```

## Worker Integration

### Agent Execution Worker (`src/core/workers/agent-execution-worker.ts`)

The worker uses `LLMProviderManager` for all LLM operations, maintaining the same unified interface:

```typescript
private async executeLLMAgent(request: AgentExecutionRequest): Promise<any> {
  const { model, prompts, parameters } = request.agent_config;
  
  const result = await LLMProviderManager.generateText(
    this.buildUserPrompt(request.task, request.input, prompts),
    {
      provider: parameters.provider || "anthropic",
      model: model,
      systemPrompt: prompts.system,
      temperature: parameters.temperature,
      maxTokens: parameters.max_tokens,
      operationContext: {
        operation: "agent_execution",
        agentId: request.agent_id,
      },
    }
  );
  
  return {
    agent_type: "llm",
    provider: parameters.provider || "anthropic",
    model: model,
    result: result,
    success: true,
  };
}
```

**Key Simplifications:**

- No custom API calling code
- No provider-specific request/response handling
- AI SDK handles all provider differences
- Unified error handling and retry logic

## Testing

### Test Coverage (`tests/providers/`)

**Core Tests:**

- `llm-providers.test.ts`: Basic generation for all providers
- `agent-worker-multi-provider.test.ts`: Worker-level multi-provider testing

**Test Approach:**

- Test actual API calls with real providers
- Fail gracefully when API keys not available
- Verify response types and structure
- Test streaming functionality

```typescript
Deno.test({
  name: "Anthropic Provider - Basic Generation",
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
```

## Benefits of This Approach

### Simplified Architecture

- **No Complex Abstractions**: Direct AI SDK usage eliminates custom provider layers
- **Type Safety**: Union types provide compile-time safety without runtime overhead
- **Maintainability**: Less code to maintain, leverages well-tested AI SDK

### Developer Experience

- **Unified Interface**: Same API for all providers
- **Runtime Flexibility**: Add new models without code changes
- **Clear Configuration**: Explicit model specification prevents confusion

### Performance

- **Client Caching**: Reuse provider clients for better performance
- **Native Streaming**: AI SDK streaming support without custom implementation
- **Minimal Overhead**: Direct provider calls through AI SDK

## Future Enhancements

### Near Term

- **Cost Tracking**: Add token usage and cost tracking per provider
- **Rate Limiting**: Provider-specific rate limiting and backoff
- **Health Monitoring**: Provider availability and performance monitoring

### Long Term

- **Auto Provider Selection**: Intelligent routing based on cost/performance
- **Fallback Chains**: Automatic failover between providers
- **Additional Providers**: Mistral, Cohere, local models via Ollama

### Possible Providers

- **Mistral AI**: `@ai-sdk/mistral`
- **Cohere**: `@ai-sdk/cohere`
- **Ollama**: `@ai-sdk/ollama` (local models)
- **Together AI**: Custom provider implementation

## Migration from Original Plan

**What Changed:**

- Eliminated complex provider interface and factory patterns
- Removed static model lists and validation
- Simplified to single `LLMProviderManager` class
- Made model field required instead of providing defaults
- Leveraged AI SDK patterns instead of custom abstractions

**Why This Approach:**

- **Simpler**: Less code to write and maintain
- **More Reliable**: Leverages battle-tested AI SDK
- **Future-Proof**: Easy to add new providers as AI SDK adds them
- **Type Safe**: Better TypeScript integration
- **Performance**: More efficient with fewer abstraction layers

This implementation successfully achieves the goal of multi-provider support while being
significantly simpler and more maintainable than the originally planned architecture.
