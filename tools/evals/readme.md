# Atlas Agent Evals

This module evaluates agent behavior using real external dependencies. We test what users experience, not mocked implementations.

## Philosophy

### 80/20 Approach

Start with basic tests that catch obvious failures. Add complexity only when you find real problems in production. Most bugs come from simple failures, not edge cases.

### Test Real Behavior

Don't mock Tavily, MCP servers, or other external tools. If the API is down, the test fails - that's the user experience. Accept the cost of real API calls for accurate evaluation.

### Binary Pass/Fail

Tests either pass or fail. No scoring systems. When a test fails, write a clear justification explaining why. This forces clarity about what "working" means.

## Writing Evals

### Basic Structure

```typescript
import { targetedResearchAgent } from "@atlas/bundled-agents";
import { assert } from "@std/assert";
import { AgentContextAdapter } from "../../lib/context.ts";
import { loadCredentials } from "../../lib/load-credentials.ts";
import { saveSnapshot } from "../../lib/snapshot.ts";

Deno.test("Agent: Specific behavior", async (t) => {
  // Load real API credentials
  await loadCredentials();

  // Create minimal context
  const adapter = new AgentContextAdapter();
  const context = adapter.createContext();

  // Execute agent with real input
  const result = await agent.execute("user prompt", context);

  // Direct assertions on output
  const pass = await t.step("", () => {
    assert(result.someField > 0, "Should produce results");
    assert(result.content.includes("expected"), "Should contain key info");
  });

  // Save output for analysis
  await saveSnapshot({
    testPath: new URL(import.meta.url),
    data: result,
    pass,
  });
});
```

### Test Categories

**Functional Tests**: Does the agent produce the expected output structure?

- Check required fields exist
- Verify output formats (list, summary, comparison)
- Ensure citations are present

**Domain Tests**: Does the agent respect filtering and constraints?

- Reddit domain filtering works
- Time range queries filter correctly
- Excluded domains aren't included

**Quality Tests**: Does the output meet user expectations?

- Information is relevant to the query
- Sources are cited properly
- No hallucinated information

### Using LLM Judges

Use LLM judges when direct assertions aren't enough:

- Output quality (relevance, completeness, accuracy)
- Multi-step reasoning correctness
- Natural language formatting

```typescript
import { llmJudge } from "../../lib/llm-judge.ts";

const evaluation = await llmJudge({
  criteria:
    "The agent should provide specific product recommendations with prices, not generic category descriptions",
  agentOutput: result,
});

assert(evaluation.pass, evaluation.justification);
```

Write criteria that distinguish good from bad outputs. Bad: "Output should be good". Good: "Each recommendation must include a specific model name and price".

## Running Evals

```bash
# Run all evals
deno task test

# Run specific eval
deno task test agents/research-agent/domain-filtering.eval.ts

# With specific credentials
ATLAS_KEY=your-key deno task test
```

## Snapshots

Every test saves a snapshot in `snapshots/` with:

- Test name
- Timestamp
- Pass/fail status
- Complete agent output

Use snapshots to:

1. **Debug failures**: Compare failing vs passing outputs
2. **Find patterns**: Group similar failures to identify systematic issues
3. **Track regressions**: Diff outputs across time to spot degradation
4. **Generate test cases**: Use interesting outputs as seeds for new tests

Don't commit all snapshots. Keep a few representative examples for documentation.

## When to Add Tests

Add a test when:

1. You fix a bug - prevent regression
2. Users report failures - capture the scenario
3. You add a feature - define expected behavior

Don't add tests for:

- Hypothetical edge cases
- Implementation details
- Things that change frequently without breaking functionality

## Key Principles

1. **Start manual**: Run agents by hand first. Understand failures before automating.
2. **Test the contract**: What users see, not how it works internally.
3. **Accept reality**: Tests with real APIs can be slow and occasionally flaky. That's OK - it reflects user experience.
4. **Clear failures**: When a test fails, the reason should be obvious from the assertion message.
5. **Iteration speed**: Better to have 5 simple tests than 1 complex one.

## Handling Flaky Tests

Real API calls can fail due to network issues or service outages. This is intentional - we want to know when dependencies are unreliable.

For persistent issues:

1. Check if the service is actually down
2. Add retry logic only if users would retry
3. Document expected failure rates in test comments

## Next Steps

As we identify common failure patterns:

1. Create targeted test suites for each pattern
2. Build specialized judges for domain-specific quality
3. Generate synthetic test cases covering more scenarios

The goal: Catch real problems quickly without false positives.
