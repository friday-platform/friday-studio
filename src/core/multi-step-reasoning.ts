/**
 * Multi-Step Reasoning Engine for Atlas
 * Provides iterative Think→Act→Observe loops with tool calling
 */

import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { logger } from "../utils/logger.ts";
import type { IWorkspaceSignal } from "../types/core.ts";
import type { AgentMetadata } from "./session-supervisor.ts";

export interface ReasoningContext {
  sessionId: string;
  workspaceId: string;
  signal: IWorkspaceSignal;
  payload: Record<string, unknown>;
  availableAgents: AgentMetadata[];
  maxIterations?: number;
  timeLimit?: number;
}

export interface ReasoningStep {
  iteration: number;
  thinking: string;
  action: ReasoningAction | null;
  observation: string;
  confidence: number;
  timestamp: number;
}

export interface ReasoningAction {
  type: "agent_call" | "tool_call" | "complete";
  agentId?: string;
  toolName?: string;
  parameters: Record<string, unknown>;
  reasoning: string;
}

export interface ReasoningResult {
  success: boolean;
  steps: ReasoningStep[];
  finalSolution: unknown;
  totalIterations: number;
  totalDuration: number;
  totalCost: number;
  errorMessage?: string;
}

export interface ToolCallResult {
  success: boolean;
  result: unknown;
  error?: string;
  duration: number;
}

export interface AgentExecutor {
  (agentId: string, input: Record<string, unknown>): Promise<unknown>;
}

export interface ToolExecutor {
  (toolName: string, parameters: Record<string, unknown>): Promise<ToolCallResult>;
}

/**
 * Multi-Step Reasoning Engine
 * Implements iterative reasoning with tool calling and agent orchestration
 */
export class MultiStepReasoningEngine {
  private model = anthropic("claude-3-5-sonnet-20241022");
  private logger = logger;

  async reason(
    context: ReasoningContext,
    agentExecutor: AgentExecutor,
    toolExecutor: ToolExecutor,
  ): Promise<ReasoningResult> {
    const startTime = Date.now();
    const steps: ReasoningStep[] = [];
    const maxIterations = context.maxIterations || 10;
    const timeLimit = context.timeLimit || 300000; // 5 minutes
    let totalCost = 0;
    let currentIteration = 0;
    let finalSolution: unknown = null;

    try {
      // Initialize working memory
      const workingMemory = {
        originalSignal: context.signal,
        originalPayload: context.payload,
        availableAgents: context.availableAgents,
        intermediateResults: [] as unknown[],
        observations: [] as string[],
      };

      while (currentIteration < maxIterations) {
        // Check time limit
        if (Date.now() - startTime > timeLimit) {
          break;
        }

        currentIteration++;
        const iterationStart = Date.now();

        // THINK: Generate reasoning about current state and next action
        const thinkingResult = await this.generateThinking(
          context,
          workingMemory,
          steps,
          currentIteration,
        );

        totalCost += thinkingResult.cost;

        // Parse action from thinking
        const action = this.parseAction(thinkingResult.thinking);

        // ACT: Execute the action if present
        let observation = "";
        if (action) {
          const actionResult = await this.executeAction(
            action,
            agentExecutor,
            toolExecutor,
            workingMemory,
          );

          observation = actionResult.observation;
          totalCost += actionResult.cost;

          // Update working memory
          if (actionResult.result !== undefined) {
            workingMemory.intermediateResults.push(actionResult.result);
          }
        } else {
          observation = "No action determined from thinking step";
        }

        // OBSERVE: Record observation and update working memory
        workingMemory.observations.push(observation);

        // Create step record
        const step: ReasoningStep = {
          iteration: currentIteration,
          thinking: thinkingResult.thinking,
          action,
          observation,
          confidence: thinkingResult.confidence,
          timestamp: Date.now(),
        };

        steps.push(step);

        // Check if we should complete
        if (action?.type === "complete") {
          finalSolution = workingMemory.intermediateResults[
            workingMemory.intermediateResults.length - 1
          ] || observation;
          break;
        }

        // If no action was taken, we might be stuck
        if (!action) {
          this.logger.warn(`No action in iteration ${currentIteration}, completing reasoning`);
          break;
        }
      }

      return {
        success: true,
        steps,
        finalSolution,
        totalIterations: currentIteration,
        totalDuration: Date.now() - startTime,
        totalCost,
      };
    } catch (error) {
      this.logger.error("Multi-step reasoning failed", { error });
      return {
        success: false,
        steps,
        finalSolution: null,
        totalIterations: currentIteration,
        totalDuration: Date.now() - startTime,
        totalCost,
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async generateThinking(
    context: ReasoningContext,
    workingMemory: any,
    previousSteps: ReasoningStep[],
    iteration: number,
  ): Promise<{ thinking: string; confidence: number; cost: number }> {
    const prompt =
      `You are an AI reasoning engine. Analyze the current situation and determine the next action.

CONTEXT:
- Session ID: ${context.sessionId}
- Workspace ID: ${context.workspaceId}
- Signal: ${JSON.stringify(context.signal)}
- Payload: ${JSON.stringify(context.payload)}
- Available Agents: ${context.availableAgents.map((a) => a.id).join(", ")}

WORKING MEMORY:
- Original Signal: ${JSON.stringify(workingMemory.originalSignal)}
- Intermediate Results: ${JSON.stringify(workingMemory.intermediateResults)}
- Recent Observations: ${workingMemory.observations.slice(-3).join(" | ")}

PREVIOUS STEPS:
${
        previousSteps.slice(-2).map((s) =>
          `Iteration ${s.iteration}: ${s.thinking.substring(0, 200)}...`
        ).join("\n")
      }

CURRENT ITERATION: ${iteration}

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

    const startTime = Date.now();
    const result = await generateText({
      model: this.model,
      prompt,
      temperature: 0.1,
      maxTokens: 1000,
    });

    const cost = this.estimateCost(result.text.length);
    const confidence = this.calculateConfidence(result.text, iteration);

    return {
      thinking: result.text,
      confidence,
      cost,
    };
  }

  private parseAction(thinking: string): ReasoningAction | null {
    try {
      // Extract action components from thinking
      const actionMatch = thinking.match(/ACTION:\s*(\w+)/i);
      const agentMatch = thinking.match(/AGENT_ID:\s*([^\n]+)/i);
      const toolMatch = thinking.match(/TOOL_NAME:\s*([^\n]+)/i);
      const parametersMatch = thinking.match(/PARAMETERS:\s*({[^}]*}|\[[^\]]*\])/i);
      const reasoningMatch = thinking.match(/REASONING:\s*([^\n]+)/i);

      if (!actionMatch) {
        return null;
      }

      const actionType = actionMatch[1].toLowerCase();
      if (!["agent_call", "tool_call", "complete"].includes(actionType)) {
        return null;
      }

      let parameters: Record<string, unknown> = {};
      if (parametersMatch) {
        try {
          parameters = JSON.parse(parametersMatch[1]);
        } catch {
          // If JSON parsing fails, treat as empty parameters
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
    } catch (error) {
      this.logger.warn("Failed to parse action from thinking", { error });
      return null;
    }
  }

  private async executeAction(
    action: ReasoningAction,
    agentExecutor: AgentExecutor,
    toolExecutor: ToolExecutor,
    workingMemory: any,
  ): Promise<{ observation: string; result?: unknown; cost: number }> {
    const startTime = Date.now();
    let cost = 0;

    try {
      switch (action.type) {
        case "agent_call": {
          if (!action.agentId) {
            return {
              observation: "Agent call failed: No agent ID specified",
              cost: 0,
            };
          }

          const result = await agentExecutor(action.agentId, action.parameters);
          const duration = Date.now() - startTime;

          return {
            observation: `Agent ${action.agentId} executed successfully in ${duration}ms. Result: ${
              JSON.stringify(result).substring(0, 200)
            }...`,
            result,
            cost,
          };
        }

        case "tool_call": {
          if (!action.toolName) {
            return {
              observation: "Tool call failed: No tool name specified",
              cost: 0,
            };
          }

          const toolResult = await toolExecutor(action.toolName, action.parameters);
          const duration = Date.now() - startTime;

          if (toolResult.success) {
            return {
              observation:
                `Tool ${action.toolName} executed successfully in ${duration}ms. Result: ${
                  JSON.stringify(toolResult.result).substring(0, 200)
                }...`,
              result: toolResult.result,
              cost,
            };
          } else {
            return {
              observation: `Tool ${action.toolName} failed: ${toolResult.error}`,
              cost: 0,
            };
          }
        }

        case "complete": {
          const finalResult = workingMemory.intermediateResults.length > 0
            ? workingMemory.intermediateResults[workingMemory.intermediateResults.length - 1]
            : "Task completed";

          return {
            observation: `Reasoning complete. Final result: ${
              JSON.stringify(finalResult).substring(0, 200)
            }...`,
            result: finalResult,
            cost: 0,
          };
        }

        default:
          return {
            observation: `Unknown action type: ${action.type}`,
            cost: 0,
          };
      }
    } catch (error) {
      return {
        observation: `Action execution failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        cost: 0,
      };
    }
  }

  private calculateConfidence(thinking: string, iteration: number): number {
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

  private estimateCost(outputTokens: number): number {
    // Rough cost estimation for Claude 3.5 Sonnet
    const inputCost = 0.003; // per 1k tokens
    const outputCost = 0.015; // per 1k tokens
    const inputTokens = 1000; // rough estimate

    return ((inputTokens * inputCost) + (outputTokens * outputCost)) / 1000;
  }
}
