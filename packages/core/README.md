# @atlas/core

Core utilities and shared components for the Atlas platform.

## LLM Provider

The LLM Provider offers a unified interface for text generation across multiple AI providers
(Anthropic, OpenAI, Google).

### Key Features

- **Single unified interface** - One `generateText` method handles all scenarios
- **Consistent return type** - Always returns `LLMResponse` with text, toolCalls, toolResults, and
  steps
- **Automatic tool detection** - Detects when tools are needed and handles them transparently
- **Clean separation of concerns** - Provider configuration vs runtime context
- **Smart tool wrapping** - Automatically wraps tools for AI SDK compatibility

### Usage

```typescript
import { type LLMOptions, LLMProvider } from "@atlas/core";

// Simple text generation
const response = await LLMProvider.generateText("Hello, world!", {
  provider: "anthropic",
  model: "claude-3-sonnet-20240229",
  temperature: 0.7,
  max_tokens: 1000,
  systemPrompt: "You are a helpful assistant.",
});

console.log(response.text); // Generated text
console.log(response.toolCalls); // [] for non-tool calls
console.log(response.toolResults); // [] for non-tool calls
console.log(response.steps); // [] for non-tool calls

// Text generation with tools
const toolResponse = await LLMProvider.generateText("What's the weather?", {
  provider: "anthropic",
  model: "claude-3-sonnet-20240229",
  tools: {
    getWeather: {
      description: "Get current weather",
      parameters: weatherSchema,
      execute: async (args) => {/* implementation */},
    },
  },
  tool_choice: "auto",
});

console.log(toolResponse.text); // Generated text with tool results
console.log(toolResponse.toolCalls); // Array of tool calls made
console.log(toolResponse.toolResults); // Array of tool results
console.log(toolResponse.steps); // Array of generation steps

// Streaming generation
const stream = LLMProvider.generateTextStream("Tell me a story", {
  provider: "openai",
  model: "gpt-4",
  temperature: 0.8,
});

for await (const chunk of stream) {
  process.stdout.write(chunk);
}
```

### Options Structure

```typescript
interface LLMOptions {
  // Provider configuration
  provider?: "anthropic" | "openai" | "google";
  model: string;
  temperature?: number;
  max_tokens?: number;
  max_steps?: number;
  tool_choice?: "auto" | "required" | "none" | { type: "tool"; toolName: string };
  apiKey?: string;
  timeout?: number;

  // Runtime context
  systemPrompt?: string;
  memoryContext?: string;
  operationContext?: Record<string, unknown>;

  // Tool integration
  tools?: Record<string, Tool>;
  mcpServers?: string[];
}
```

### Migration from Old API

```typescript
// Old API (before)
const text = await LLMProvider.generateText(prompt, {
  systemPrompt: "...",
  includeMemoryContext: true,
});

const toolResult = await LLMProvider.generateTextWithTools(prompt, {
  systemPrompt: "...",
  mcpServers: ["server1"],
  tools: {/* ... */},
});

// New API (after)
const response = await LLMProvider.generateText(prompt, {
  model: "claude-3-sonnet-20240229", // Now required
  systemPrompt: "...",
  memoryContext: "...", // Explicit context instead of boolean flag
});

const toolResponse = await LLMProvider.generateText(prompt, {
  model: "claude-3-sonnet-20240229",
  systemPrompt: "...",
  mcpServers: ["server1"],
  tools: {/* ... */},
});
// Note: Same method, tools are just optional parameters
```
