/**
 * Core reasoning logic extracted from MultiStepReasoningEngine
 * These are pure functions that can be used with the state machine
 */

import type { ReasoningAction, ReasoningContext } from "./types.ts";

/**
 * Generate thinking based on current context using LLMProvider
 */
export async function generateThinking<T>(
  context: ReasoningContext<T>,
  customPrompt?: string,
): Promise<{ thinking: string; confidence: number }> {
  // Dynamically import LLMProvider to avoid circular dependencies
  const { LLMProvider } = await import("@atlas/core");

  const prompt = customPrompt || createDefaultPrompt(context);

  const result = await LLMProvider.generateText(prompt, {
    systemPrompt:
      "You are an AI reasoning engine that follows a structured Think→Act→Observe loop.",
    model: "gemini-2.5-flash",
    provider: "google",
    temperature: 0.1,
    max_tokens: 4000, // Reasonable default for reasoning steps
    operationContext: {
      operation: "reasoning_think_step",
      iteration: context.currentIteration + 1,
      workspaceId: (context.userContext as any)?.workspaceId,
      sessionId: (context.userContext as any)?.sessionId,
    },
  });

  const confidence = calculateConfidence(result.text, context.currentIteration);

  return {
    thinking: result.text,
    confidence,
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

    const actionType = actionMatch[1].toLowerCase();
    if (!["agent_call", "tool_call", "complete"].includes(actionType)) {
      return null;
    }

    // Extract parameters with better JSON handling
    let parameters: Record<string, unknown> = {};
    const parametersStartMatch = thinking.match(/PARAMETERS:\s*/i);
    if (parametersStartMatch) {
      const startIndex = parametersStartMatch.index! + parametersStartMatch[0].length;
      const remainingText = thinking.substring(startIndex);

      // Try to extract JSON by counting braces
      if (remainingText.trimStart().startsWith("{")) {
        let braceCount = 0;
        let inString = false;
        let escapeNext = false;
        let jsonEnd = -1;

        for (let i = 0; i < remainingText.length; i++) {
          const char = remainingText[i];

          if (escapeNext) {
            escapeNext = false;
            continue;
          }

          if (char === "\\") {
            escapeNext = true;
            continue;
          }

          if (char === '"' && !escapeNext) {
            inString = !inString;
            continue;
          }

          if (!inString) {
            if (char === "{") {
              braceCount++;
            } else if (char === "}") {
              braceCount--;
              if (braceCount === 0) {
                jsonEnd = i + 1;
                break;
              }
            }
          }
        }

        if (jsonEnd > 0) {
          try {
            const jsonString = remainingText.substring(0, jsonEnd);
            parameters = JSON.parse(jsonString);
          } catch (e) {
            // If JSON parsing fails, try to clean it up
            try {
              // Remove any trailing content after the JSON
              const cleanJson = remainingText.substring(0, jsonEnd).trim();
              parameters = JSON.parse(cleanJson);
            } catch {
              parameters = {};
            }
          }
        }
      }
    }

    return {
      type: actionType as ReasoningAction["type"],
      agentId: agentMatch?.[1]?.trim(),
      toolName: toolMatch?.[1]?.trim(),
      parameters,
      reasoning: reasoningMatch?.[1]?.trim() || "No reasoning provided",
    };
  } catch (error) {
    return null;
  }
}

/**
 * Create default reasoning prompt
 */
function createDefaultPrompt<T>(context: ReasoningContext<T>): string {
  const { userContext, steps, workingMemory, currentIteration } = context;

  // Extract recent observations
  const recentObservations = steps.slice(-3).map((s) => s.observation).join(" | ");

  // Extract recent results from working memory
  const recentResults = Array.from(workingMemory.entries())
    .filter(([key]) => key.startsWith("result_"))
    .slice(-2)
    .map(([_, value]) => JSON.stringify(value).substring(0, 100))
    .join(" | ");

  return `You are an AI reasoning engine. Analyze the current situation and determine the next action.

CONTEXT:
${JSON.stringify(userContext, null, 2)}

WORKING MEMORY:
- Recent Observations: ${recentObservations || "None yet"}
- Recent Results: ${recentResults || "None yet"}
- Iteration: ${currentIteration + 1}

PREVIOUS STEPS:
${
    steps.slice(-2).map((s) => `Iteration ${s.iteration}: ${s.thinking.substring(0, 200)}...`).join(
      "\n",
    ) || "No previous steps"
  }

Think step by step about what needs to be done. Then, determine the next action.

ACTION TYPES:
1. agent_call: Call an agent with specific input
2. tool_call: Use a tool with parameters  
3. complete: Finish reasoning with final solution

Provide your response in this format:
THINKING: [Your detailed reasoning about the current state and what needs to be done next]

ACTION: [One of the action types above]
AGENT_ID: [If agent_call, specify which agent]
TOOL_NAME: [If tool_call, specify which tool]
PARAMETERS: [JSON object with parameters]
REASONING: [Why this action is needed]

If you believe the task is complete or no further action is needed, use ACTION: complete.`;
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
