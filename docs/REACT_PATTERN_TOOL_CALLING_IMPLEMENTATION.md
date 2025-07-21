# ReAct Pattern Tool Calling Implementation Plan

## Overview

This document outlines the implementation plan for aligning the Atlas reasoning package with the
pure ReAct pattern, where tools are only executed during the Act phase while maintaining LLM
awareness of tool schemas during the Think phase.

## Problem Statement

The current implementation allows tools to be called during the Think phase via the Vercel AI SDK,
which violates the ReAct pattern's separation of concerns:

- **Think**: Should only reason about the problem
- **Act**: Should execute ONE action (tool call, agent call, or complete)
- **Observe**: Should record the result

## Solution: Tool Awareness Without Execution

Pass tools to the LLM with `tool_choice: "none"` during thinking to provide schema awareness without
allowing execution.

## Implementation Changes

### 1. Update `reasoning-logic.ts`

#### 1.1 Modify `generateThinking` function

```typescript
export async function generateThinking<TUserContext extends BaseReasoningContext>(
  context: ReasoningContext<TUserContext>,
  customPrompt?: string,
): Promise<ReasoningCompletion> {
  const prompt = customPrompt || createDefaultPrompt(context);

  const result = await LLMProvider.generateText(prompt, {
    systemPrompt:
      "You are an AI reasoning engine that follows a structured Think→Act→Observe loop. " +
      "During thinking, you can see available tools but cannot execute them. " +
      "You must specify tool calls explicitly in your ACTION output.",
    model: "claude-3-7-sonnet-latest",
    provider: "anthropic",
    temperature: 0.1,
    max_tokens: 4000,
    tools: context.userContext.tools,
    tool_choice: "none", // Critical: prevents tool execution during thinking
    operationContext: {
      operation: "reasoning_think_step",
      iteration: context.currentIteration + 1,
      workspaceId: context.userContext.workspaceId,
      sessionId: context.userContext.sessionId,
    },
  });

  // Since tool_choice is "none", toolCalls will be empty
  // The LLM will describe intended tool calls in the text
  const confidence = calculateConfidence(
    result.text,
    context.currentIteration,
  );
  const isComplete = result.text.includes("ACTION: complete") ||
    result.text.toLowerCase().includes("task complete") ||
    result.text.toLowerCase().includes("finished");

  return {
    thinking: { text: result.text, toolCalls: [] }, // toolCalls always empty
    confidence,
    isComplete,
  };
}
```

#### 1.2 Enhance `parseAction` function

````typescript
export function parseAction(thinking: ReasoningThinking): ReasoningAction | null {
  try {
    const text = thinking.text;
    const actionMatch = text.match(/ACTION:\s*(\w+)/i);
    const agentMatch = text.match(/AGENT_ID:\s*([^\n]+)/i);
    const toolMatch = text.match(/TOOL_NAME:\s*([^\n]+)/i);
    const reasoningMatch = text.match(/REASONING:\s*([^\n]+)/i);
    const toolCallIdMatch = text.match(/TOOL_CALL_ID:\s*([^\n]+)/i);

    if (!actionMatch) {
      return null;
    }

    const actionType = actionMatch[1]?.toLowerCase();
    if (!actionType) {
      return null;
    }
    if (!["agent_call", "tool_call", "complete"].includes(actionType)) {
      return null;
    }

    // Extract parameters with improved JSON parsing
    let parameters: Record<string, unknown> = {};

    // Try multiple parameter formats
    const parametersMatch = text.match(/PARAMETERS:\s*({[\s\S]*?})\s*(?:REASONING:|$)/i) ||
      text.match(/PARAMETERS:\s*```json\s*({[\s\S]*?})\s*```/i) ||
      text.match(/PARAMETERS:\s*({[^}]+})/i);

    if (parametersMatch && parametersMatch[1]) {
      try {
        parameters = JSON.parse(parametersMatch[1]);
      } catch (e) {
        // Try to clean common JSON issues
        let cleanJson = parametersMatch[1]
          .replace(/'/g, '"') // Replace single quotes
          .replace(/(\w+):/g, '"$1":') // Quote unquoted keys
          .replace(/,\s*}/, "}") // Remove trailing commas
          .replace(/,\s*]/, "]");

        try {
          parameters = JSON.parse(cleanJson);
        } catch (e2) {
          console.error("Failed to parse parameters JSON:", e2);
          parameters = {};
        }
      }
    }

    return {
      type: actionType as ReasoningAction["type"],
      agentId: agentMatch?.[1]?.trim(),
      toolName: toolMatch?.[1]?.trim(),
      parameters,
      reasoning: reasoningMatch?.[1]?.trim() || "No reasoning provided",
      toolCallId: toolCallIdMatch?.[1]?.trim(),
    };
  } catch (_error) {
    return null;
  }
}
````

#### 1.3 Update `createDefaultPrompt` function

```typescript
function createDefaultPrompt<TUserContext extends BaseReasoningContext>(
  context: ReasoningContext<TUserContext>,
): string {
  const { userContext, steps, workingMemory, currentIteration } = context;

  // Generate tool descriptions from schemas
  const toolDescriptions = Object.entries(userContext.tools || {})
    .map(([name, tool]) => {
      let paramDesc = "No parameters";
      if (tool.parameters) {
        // Extract parameter info from Zod schema if available
        try {
          const shape = tool.parameters._def?.shape?.() || tool.parameters._def?.shape || {};
          paramDesc = Object.entries(shape)
            .map(([key, schema]: [string, any]) => {
              const description = schema._def?.description || "No description";
              return `  - ${key}: ${description}`;
            })
            .join("\n");
        } catch {
          paramDesc = "Parameters available (see schema)";
        }
      }
      return `- ${name}: ${tool.description || "No description"}\n${paramDesc}`;
    })
    .join("\n\n");

  const recentObservations = steps.slice(-2).map((s) => s.observation).join(" | ");
  const recentResults = Array.from(workingMemory.entries())
    .filter(([key]) => key.startsWith("result_"))
    .slice(-1)
    .map(([_, value]) => JSON.stringify(value).substring(0, 150))
    .join(" | ");

  return `You are an AI reasoning engine following the ReAct pattern. You must think step-by-step and specify actions explicitly.

**AVAILABLE TOOLS:**
${toolDescriptions || "No tools available"}

**CONTEXT:**
Task: ${userContext.task || JSON.stringify(userContext)}

**MEMORY:**
- Observations: ${recentObservations || "None"}
- Results: ${recentResults || "None"}
- Iteration: ${currentIteration + 1}

**PREVIOUS STEPS:**
${
    steps.length > 0
      ? steps.slice(-2).map((s) => `Step ${s.iteration}: ${s.thinking.text}`).join("\n")
      : "No previous steps."
  }

**INSTRUCTIONS:**
1. THINKING: Analyze the current situation and plan your next action
2. ACTION: Specify exactly ONE action (tool_call, agent_call, or complete)
3. For tool_call, you MUST provide the exact tool name and parameters

**REQUIRED FORMAT:**
THINKING: [Your reasoning about what to do next]
ACTION: [tool_call|agent_call|complete]
TOOL_NAME: [exact tool name if ACTION is tool_call]
PARAMETERS: {"key": "value"} [JSON parameters if ACTION is tool_call]
REASONING: [Why this action will help achieve the goal]

**IMPORTANT:** You can see available tools above but CANNOT execute them directly. You must specify tool calls in the ACTION format.`;
}
```

### 2. Update Test File `integration-tests/reasoning-llm-tools.test.ts`

Add assertions to verify:

1. Tool calls don't happen during thinking
2. Tools are properly parsed from thinking text
3. Tools execute only during the execution phase

```typescript
// Add to the test callbacks
think: async (context) => {
  stepCount++;
  const result = await generateThinking(context);
  
  // Verify no tool calls occurred during thinking
  assertEquals(
    result.thinking.toolCalls.length,
    0,
    "No tool calls should occur during thinking phase"
  );
  
  console.log({ 
    thinking: result.thinking.text,
    hasToolCalls: result.thinking.toolCalls.length > 0 
  });
  
  return result;
},

parseAction: (thinking) => {
  const action = parseAction(thinking);
  
  // Log parsed action for debugging
  console.log({
    parsedAction: action,
    fromThinking: thinking.text.substring(0, 200)
  });
  
  // Verify action was properly parsed from text
  if (action?.type === "tool_call") {
    assertExists(action.toolName, "Tool name must be parsed from thinking");
    assertExists(action.parameters, "Parameters must be parsed from thinking");
  }
  
  return action;
},
```

### 3. Add Integration Test for ReAct Pattern Compliance

Create a new test file: `integration-tests/react-pattern-compliance.test.ts`

```typescript
Deno.test({
  name: "ReAct Pattern - Tools Only Execute During Act Phase",
  ignore: !Deno.env.get("ANTHROPIC_API_KEY"),
  fn: async () => {
    const thinkingPhaseTools: string[] = [];
    const executionPhaseTools: string[] = [];

    const machine = createReasoningMachine({
      think: async (context) => {
        const result = await generateThinking(context);

        // Track if any tools were called during thinking
        if (result.thinking.toolCalls.length > 0) {
          thinkingPhaseTools.push(...result.thinking.toolCalls.map((tc) => tc.toolName));
        }

        return result;
      },

      parseAction: parseAction,

      executeAction: async (action, context) => {
        if (action.type === "tool_call" && action.toolName) {
          executionPhaseTools.push(action.toolName);
          // Execute tool...
        }
        // ...
      },
    });

    // Run machine...

    // Verify ReAct compliance
    assertEquals(
      thinkingPhaseTools.length,
      0,
      "No tools should execute during thinking phase",
    );

    assert(
      executionPhaseTools.length > 0,
      "Tools should only execute during execution phase",
    );
  },
});
```

## Testing Strategy

1. **Unit Tests**
   - Test `parseAction` with various thinking formats
   - Test parameter extraction with different JSON formats
   - Test tool description generation

2. **Integration Tests**
   - Verify no tools execute during thinking
   - Verify tools execute only during action phase
   - Test full Think→Act→Observe cycles
   - Test error handling when tool parsing fails

3. **Edge Cases**
   - Malformed JSON in PARAMETERS
   - Missing tool names
   - Invalid action types
   - Tools not available in context

## Migration Notes

1. **Breaking Changes**
   - `thinking.toolCalls` will always be empty
   - Tool intentions must be parsed from thinking text
   - Requires explicit ACTION format in prompts

2. **Backwards Compatibility**
   - Consider adding a flag to enable/disable pure ReAct mode
   - Provide migration guide for existing implementations

## Benefits

1. **True ReAct Pattern**: Clear separation between thinking and acting
2. **Transparency**: All tool intentions visible in thinking text
3. **Control**: Explicit control over when tools execute
4. **Debugging**: Easier to trace decision-making process
5. **Safety**: Prevents unintended tool execution during reasoning

## Timeline

1. **Phase 1**: Update core logic (2 days)
   - Modify `generateThinking`
   - Enhance `parseAction`
   - Update prompts

2. **Phase 2**: Testing (2 days)
   - Write comprehensive tests
   - Fix edge cases
   - Performance testing

3. **Phase 3**: Documentation (1 day)
   - Update API docs
   - Migration guide
   - Examples

## Success Criteria

1. Tools never execute during thinking phase
2. All tool intentions clearly expressed in thinking text
3. 100% test coverage for new parsing logic
4. No performance degradation
5. Clear migration path for existing users
