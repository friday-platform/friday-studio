/**
 * Core reasoning logic extracted from MultiStepReasoningEngine
 * These are pure functions that can be used with the state machine
 */

import type {
  BaseReasoningContext,
  ReasoningAction,
  ReasoningCompletion,
  ReasoningContext,
} from "./types.ts";
import { LLMProvider } from "@atlas/core";

/**
 * Generate thinking based on current context using LLMProvider
 */
export async function generateThinking<TUserContext extends BaseReasoningContext>(
  context: ReasoningContext<TUserContext>,
  customPrompt?: string,
): Promise<ReasoningCompletion> {
  const prompt = customPrompt || createDefaultPrompt(context);

  const result = await LLMProvider.generateText(prompt, {
    systemPrompt:
      "You are an AI reasoning engine that follows a structured Think→Act→Observe loop.",
    model: "claude-3-7-sonnet-latest",
    provider: "anthropic",
    temperature: 0.1,
    max_tokens: 4000,
    tools: context.userContext.tools,
    operationContext: {
      operation: "reasoning_think_step",
      iteration: context.currentIteration + 1,
      workspaceId: context.userContext.workspaceId,
      sessionId: context.userContext.sessionId,
    },
  });

  const confidence = calculateConfidence(
    result.text,
    context.currentIteration,
  );
  const isComplete = result.text.includes("ACTION: complete") ||
    result.text.toLowerCase().includes("task complete") ||
    result.text.toLowerCase().includes("finished");

  return {
    thinking: { text: result.text, toolCalls: result.toolCalls },
    confidence,
    isComplete,
  };
}

/**
 * Parse action from thinking text
 */
export function parseAction(thinking: string): ReasoningAction | null {
  try {
    const actionMatch = thinking.match(/ACTION:\s*(\w+)/i);
    const agentMatch = thinking.match(/AGENT_ID:\s*([^\n]+)/i);
    const toolMatch = thinking.match(/TOOL_NAME:\s*([^\n]+)/i);
    const reasoningMatch = thinking.match(/REASONING:\s*([^\n]+)/i);

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

    // Extract parameters with a more robust JSON parsing
    let parameters: Record<string, unknown> = {};
    const parametersMatch = thinking.match(/PARAMETERS:\s*({[\s\S]*})/i);
    if (parametersMatch && parametersMatch[1]) {
      try {
        parameters = JSON.parse(parametersMatch[1]);
      } catch (e) {
        // Handle cases where the JSON might be slightly malformed
        // For example, by trying to fix common issues or just failing gracefully
        console.error("Failed to parse parameters JSON:", e);
        parameters = {};
      }
    }

    return {
      type: actionType as ReasoningAction["type"],
      agentId: agentMatch?.[1]?.trim(),
      toolName: toolMatch?.[1]?.trim(),
      parameters,
      reasoning: reasoningMatch?.[1]?.trim() || "No reasoning provided",
    };
  } catch (_error) {
    return null;
  }
}

/**
 * Create default reasoning prompt
 */
function createDefaultPrompt<TUserContext extends BaseReasoningContext>(
  context: ReasoningContext<TUserContext>,
): string {
  const { userContext, steps, workingMemory, currentIteration } = context;

  const recentObservations = steps.slice(-2).map((s) => s.observation).join(
    " | ",
  );
  const recentResults = Array.from(workingMemory.entries())
    .filter(([key]) => key.startsWith("result_"))
    .slice(-1)
    .map(([_, value]) => JSON.stringify(value).substring(0, 150))
    .join(" | ");

  return `You are an AI reasoning engine. Your goal is to solve the user's request by thinking step-by-step and executing actions.

**CONTEXT:**
${JSON.stringify(userContext, null, 2)}

**MEMORY:**
- Observations: ${recentObservations || "None"}
- Results: ${recentResults || "None"}
- Iteration: ${currentIteration + 1}

**PREVIOUS STEPS:**
${
    steps.length > 0
      ? steps.slice(-2).map((s) => `Step ${s.iteration}: ${JSON.stringify(s.thinking, null, 2)}`)
        .join("\n")
      : "No previous steps."
  }

**INSTRUCTIONS:**
1.  **Analyze**: Review the context, memory, and previous steps.
2.  **Think**: Formulate a plan in the 'THINKING' block.
3.  **Act**: Specify ONE action ('agent_call', 'tool_call', 'complete').
4.  **Complete**: If the goal is met, use 'ACTION: complete'.

**FORMAT:**
THINKING: [Your reasoning and plan]
ACTION: [agent_call|tool_call|complete]
AGENT_ID: [agent_id]
TOOL_NAME: [tool_name]
PARAMETERS: { "key": "value" }
REASONING: [Justification for the action]`;
}

/**
 * Calculate confidence based on thinking structure and iteration
 */
function calculateConfidence(thinking: string, iteration: number): number {
  let confidence = 0.7; // Base confidence

  // Higher confidence for structured thinking
  if (thinking.includes("THINKING:") && thinking.includes("ACTION:")) {
    confidence += 0.1;
  }

  // Higher confidence for specific actions
  if (thinking.includes("AGENT_ID:") || thinking.includes("TOOL_NAME:")) {
    confidence += 0.1;
  }

  // Lower confidence for later iterations (potential confusion)
  confidence -= (iteration - 1) * 0.05;

  // Ensure confidence is within bounds
  return Math.max(0.1, Math.min(1.0, confidence));
}
