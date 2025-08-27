# Atlas Agent Evaluation Framework

Test Atlas agents without the full server stack using evalite.

## Quick Start

```bash
bun install
# Run evaluations
bun run eval
# With a scoring UI
bun run eval:dev
```

## What This Does

Evaluates agent behavior by:

- Running agents with mock contexts
- Testing against generated and custom test cases
- Scoring responses with LLM and rule-based scorers
- Displaying results in evalite's UI

## Writing Evaluations

```typescript
import { evalite } from "evalite";
import type { AtlasAgent } from "@atlas/agent-sdk";
import { AgentContextAdapter } from "../lib/context";

const myAgent: AtlasAgent = {
  /* your agent implementation */
};

evalite("My Agent", {
  data: () => [
    {
      input: { prompt: "test prompt", mockTools: ["tool1"] },
      expected: "expected behavior",
    },
  ],

  task: async (input) => {
    // Create mock tools from tool names
    const tools =
      input.mockTools?.reduce((acc, name) => {
        acc[name] = createMockTool(name);
        return acc;
      }, {} as AtlasTools) || {};

    const adapter = new AgentContextAdapter(
      tools,
      input.mockEnv,
      input.mockMemories,
    );
    const context = adapter.createContext();
    const enrichedPrompt = adapter.enrichPrompt(input.prompt);
    return await myAgent.execute(enrichedPrompt, context);
  },

  scorers: [
    /* your scorers */
  ],
});
```

## Available Scorers

- **llmScorer**: Uses Claude to judge response quality (implemented in `lib/llm-scorer.ts`)

Additional scorers can be created using evalite's `createScorer` function.

## Test Data Generation

Generate test cases from agent expertise:

```typescript
function getTestCases(expertise: AgentExpertise) {
  const cases = [];

  // Test each capability
  for (const capability of expertise.capabilities) {
    cases.push({
      prompt: `Test ${capability}`,
      expectedBehavior: `Should demonstrate ${capability}`,
      mockTools: [
        /* tool names for this capability */
      ],
    });
  }

  // Test examples from agent metadata
  for (const example of expertise.examples) {
    cases.push({ prompt: example, expected: "Handle example correctly" });
  }

  // Add edge cases
  cases.push(
    { prompt: "", testType: "invalid-input" },
    { prompt: "help", expected: "Provide guidance" },
  );

  return cases;
}
```

## Mock Tools

Create mock tools at runtime:

```typescript
function createMockTool(name: string): AtlasTool {
  return {
    description: `Mock ${name}`,
    parameters: { type: "object", properties: {} },
    execute: async (args) => ({ tool: name, args, result: "mocked" }),
  };
}
```

## Context Adapter

Provides minimal AgentContext for testing:

```typescript
class AgentContextAdapter {
  constructor(tools = {}, env = {}, memories = []) {}

  createContext(): AgentContext {
    return {
      tools: this.tools,
      env: this.env,
      session: { sessionId, workspaceId, userId },
      stream: { emit: () => {}, end: () => {}, error: () => {} },
      logger: console,
    };
  }

  enrichPrompt(prompt: string): string {
    // Prepend memories to prompt
    return this.memories?.length
      ? `${this.memories.join("\n")}\n\n${prompt}`
      : prompt;
  }
}
```

## Environment Variables

```bash
export ANTHROPIC_API_KEY=your-key  # For LLM scoring
```

## Current Limitations

- Mock tools don't connect to real services
- No MCP server integration
- Memory is just text prepended to prompts
- Stream events are no-ops

## Files

- `lib/context.ts`: AgentContext adapter
- `lib/llm-scorer.ts`: LLM-based scoring
- `evals/*.eval.ts`: Agent evaluations
