# Reasoning System Fixes

## Fix 1: Handle null emit in reasoning machine

In `packages/reasoning/src/machine.ts`, update the emit on line 118-121:

```typescript
// BEFORE:
emit(({ context }) => {
  const action = context.currentStep?.action;
  return action ? { type: "reasoning.action.determined", action } : undefined;
}),

// AFTER:
emit(({ context }) => {
  const action = context.currentStep?.action;
  // Only emit if we have a valid action, don't emit undefined
  if (action) {
    return { type: "reasoning.action.determined", action };
  }
  // Return a valid "no action" event instead of undefined
  return { type: "reasoning.no_action_determined" };
}),
```

## Fix 2: Improve LLM parameters generation

In `conversation-agent.ts`, update the reasoning tool schema to make parameters required when action
is tool_call:

```typescript
// Update the reasoning tool parameters (around line 859)
parameters: {
  type: "object",
  properties: {
    thinking: {
      type: "string",
      description: "Your detailed analysis of what the user needs and your current progress",
    },
    action: {
      type: "string",
      enum: ["tool_call", "complete"],
      description: "The type of action to take",
    },
    toolName: {
      type: "string",
      description: "The name of the tool to call (required if action is tool_call)",
    },
    parameters: {
      type: "object",
      description: "The parameters for the tool call (required if action is tool_call)",
      additionalProperties: true,
    },
    reasoning: {
      type: "string",
      description: "Why you chose this action",
    },
  },
  required: ["thinking", "action", "reasoning"],
  // Add conditional requirements based on action type
  allOf: [
    {
      if: { properties: { action: { const: "tool_call" } } },
      then: { required: ["toolName", "parameters"] }
    }
  ]
},
```

## Fix 3: Improve isComplete logic

Update the `isComplete` callback in conversation-agent.ts (around line 1131):

```typescript
isComplete: (context) => {
  const lastStep = context.steps[context.steps.length - 1];
  
  // Complete if action type is "complete"
  if (lastStep?.action?.type === "complete") {
    return true;
  }
  
  // Complete if we've hit max iterations
  if (context.currentIteration >= context.maxIterations) {
    return true;
  }
  
  // For simple queries that only need a stream_reply
  const hasStreamReply = context.steps.some(
    step => step.action?.toolName === "stream_reply" && step.result
  );
  
  // If this is a simple conversation (no workspace operations mentioned)
  const userMessage = context.userContext.message.toLowerCase();
  const isSimpleQuery = !userMessage.includes("workspace") && 
                       !userMessage.includes("agent") &&
                       !userMessage.includes("create") &&
                       !userMessage.includes("build");
  
  // Complete after stream_reply for simple queries
  if (hasStreamReply && isSimpleQuery && context.currentIteration >= 2) {
    return true;
  }
  
  // Continue for workspace operations
  return false;
},
```

## Fix 4: Add timeout handling

Add better timeout handling in the think callback:

```typescript
// Wrap the LLM call with a shorter timeout (around line 890)
const result = await Promise.race([
  LLMProvider.generateText(thinkingPrompt, {
    systemPrompt:
      `${this.prompts.system}\n\nYou are now in reasoning mode. Plan your response step by step.`,
    model: this.agentConfig.model || "claude-3-7-sonnet-latest",
    provider: "google",
    temperature: 0.3,
    max_tokens: 8000,
    tools: reasoningTool,
    tool_choice: "required",
    operationContext: {
      operation: "conversation_reasoning",
      agentId: this.id,
    },
  }),
  new Promise((_, reject) => setTimeout(() => reject(new Error("Thinking timeout")), 15000) // 15 second timeout
  ),
]).catch((error) => {
  this.logger.warn("Think callback timeout or error", { error: error.message });
  // Return a completion action on timeout
  return {
    toolCalls: [{
      toolName: "reasoning_action",
      args: {
        thinking: "Thinking process timed out. Completing current task.",
        action: "complete",
        reasoning: "Timeout reached, completing to avoid infinite loop",
      },
    }],
  };
});
```

## Fix 5: Add debug logging

Add comprehensive debug logging throughout the reasoning flow:

```typescript
// In think callback, log the full prompt and response
this.logger.debug("Reasoning think prompt", {
  prompt: thinkingPrompt,
  previousSteps: previousSteps.length,
  currentIteration: context.currentIteration,
});

// Log the structured output parsing
this.logger.debug("Reasoning structured output", {
  hasToolCall: !!toolCall,
  toolName: toolCall?.toolName,
  args: toolCall?.args,
  validation: validatedArgs ? "passed" : "failed",
});

// In parseAction, log what's being parsed
this.logger.debug("Parsing action from thinking", {
  hasJsonMatch: !!jsonMatch,
  jsonData: jsonMatch ? JSON.parse(jsonMatch[1]) : null,
  fallbackToRegex: !jsonMatch,
});
```

## Summary

These fixes address:

1. The XState crash when no action is determined
2. Improved parameter generation from LLM
3. Better completion detection to avoid unnecessary iterations
4. Timeout handling to prevent 30-second hangs
5. Debug logging for easier troubleshooting

The key insight is that the reasoning loop needs better guard rails:

- Handle edge cases where LLM doesn't provide expected output
- Detect when reasoning should complete vs continue
- Prevent infinite loops with proper timeouts
- Provide fallback behaviors for error cases
