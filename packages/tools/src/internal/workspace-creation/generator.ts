import { stepCountIs, streamText } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import type { WorkspaceConfig } from "@atlas/config";
import { workspaceBuilder, workspaceBuilderTools } from "./tools.ts";
import { WORKSPACE_ARCHITECT_SYSTEM_PROMPT } from "./prompts.ts";
import type { WorkspaceRequirements } from "./generation.ts";
import { logger } from "../../../../../src/utils/logger.ts";

interface AttemptResult {
  attempt: number;
  errors?: string[];
  error?: string;
}

interface GenerationResult {
  config: WorkspaceConfig;
  reasoning: string;
}

export class WorkspaceGenerator {
  private anthropic: ReturnType<typeof createAnthropic>;
  private attemptHistory: AttemptResult[] = [];

  constructor() {
    this.anthropic = createAnthropic({
      apiKey: Deno.env.get("ANTHROPIC_API_KEY"),
    });
  }

  async generateWorkspace(
    userIntent: string,
    conversationContext?: string,
    requirements?: WorkspaceRequirements,
    maxAttempts: number = 3,
  ): Promise<GenerationResult> {
    this.attemptHistory = [];

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      logger.info(`Starting workspace generation attempt ${attempt}/${maxAttempts}`);

      try {
        // Reset workspace builder for fresh attempt
        logger.debug("Resetting workspace builder");
        workspaceBuilder.reset();

        logger.debug(`Building prompt for attempt ${attempt}`);
        const prompt = this.buildAttemptPrompt(
          userIntent,
          attempt,
          conversationContext,
          requirements,
          this.getLastErrors(),
        );

        // Use streamText to capture real-time thinking and tool calls
        const aiStartTime = Date.now();
        logger.info("Starting AI workspace generation with Claude Sonnet 4");

        let capturedThinking = "";
        const toolCallSummary: string[] = [];
        let finalText = "";

        const result = streamText({
          model: this.anthropic("claude-sonnet-4-20250514"),
          system: WORKSPACE_ARCHITECT_SYSTEM_PROMPT,
          prompt,
          maxOutputTokens: 8000,
          tools: workspaceBuilderTools,
          stopWhen: stepCountIs(60),
          temperature: this.getTemperatureForAttempt(attempt),
          providerOptions: {
            anthropic: {
              thinking: { type: "enabled", budgetTokens: 7000 },
            },
          },
          onChunk({ chunk }) {
            if (chunk.type === "tool-call") {
              logger.debug(`Tool call: ${chunk.toolName}`);
              toolCallSummary.push(`${chunk.toolName}()`);
            }
          },
        });

        // Process the full stream to capture thinking and tool calls
        for await (const chunk of result.fullStream) {
          if (chunk.type === "text") {
            finalText += chunk.text;
          } else if (chunk.type === "reasoning") {
            capturedThinking += chunk.text || "";
          }
        }

        const aiEndTime = Date.now();
        const totalAiTime = aiEndTime - aiStartTime;

        logger.debug(`AI generation completed in ${totalAiTime}ms`);
        logger.debug(`Tool execution sequence: ${toolCallSummary.join(" → ")}`);

        // Check if we have minimum components for a functional workspace
        logger.debug("Analyzing generated workspace components");
        let hasMinimumComponents = false;
        let signalCount = 0, agentCount = 0, jobCount = 0;
        try {
          const config = workspaceBuilder.exportConfig();
          signalCount = Object.keys(config.signals || {}).length;
          agentCount = Object.keys(config.agents || {}).length;
          jobCount = Object.keys(config.jobs || {}).length;

          logger.debug(
            `Workspace components: ${signalCount} signals, ${agentCount} agents, ${jobCount} jobs`,
          );
          hasMinimumComponents = signalCount >= 1 && agentCount >= 1 && jobCount >= 1;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.debug(`Failed to export config: ${errorMessage}`);
          hasMinimumComponents = false;
        }

        // Only validate if we have minimum components, otherwise force failure
        logger.debug("Running workspace validation");
        const validation = hasMinimumComponents ? workspaceBuilder.validateWorkspace() : {
          success: false,
          errors: ["Workspace incomplete - missing signals, agents, or jobs"],
          warnings: [],
        };

        if (validation.success) {
          logger.info(`Workspace generation attempt ${attempt} succeeded`);
          const config = workspaceBuilder.exportConfig();
          logger.debug(
            `Generated workspace with ${signalCount} signals, ${agentCount} agents, ${jobCount} jobs`,
          );

          return {
            config,
            reasoning: this.buildSuccessReasoning(
              attempt,
              finalText,
              capturedThinking,
              toolCallSummary,
            ),
          };
        }

        // Record validation failure
        logger.debug(`Attempt ${attempt} failed validation: ${validation.errors.join(", ")}`);
        this.attemptHistory.push({
          attempt,
          errors: validation.errors,
        });
      } catch (error) {
        // Record execution error
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.debug(`Attempt ${attempt} threw error: ${errorMessage}`);
        this.attemptHistory.push({
          attempt,
          error: errorMessage,
        });
      }
    }

    // All attempts failed
    logger.info(`Workspace generation failed after ${maxAttempts} attempts`);
    throw new Error(this.buildFailureMessage(maxAttempts));
  }

  private buildAttemptPrompt(
    userIntent: string,
    attempt: number,
    conversationContext?: string,
    requirements?: WorkspaceRequirements,
    lastErrors?: string[],
  ): string {
    let prompt = `# Workspace Generation Request

**User Intent**: ${userIntent}`;

    if (conversationContext) {
      prompt += `\n\n**Conversation Context**: ${conversationContext}`;
    }

    if (requirements) {
      prompt += `\n\n**Requirements**: ${JSON.stringify(requirements, null, 2)}`;
    }

    if (attempt > 1 && lastErrors?.length) {
      prompt += `\n\n## Previous Attempt Failed

**Attempt**: ${attempt}/${3}
**Previous Errors**:
${lastErrors.map((error) => `- ${error}`).join("\n")}

Please analyze these errors and adjust your approach accordingly.`;
    }

    prompt += `\n\n## Instructions

Create a complete Atlas workspace configuration using the provided tools. You MUST call ALL necessary tools in this exact sequence:

1. REQUIRED: Call initializeWorkspace first
2. REQUIRED: Call addScheduleSignal OR addWebhookSignal for triggers
3. REQUIRED: Call addLLMAgent AND/OR addRemoteAgent for workers
4. REQUIRED: Call createJob to connect signals to agents
5. OPTIONAL: Call addMCPIntegration if external services needed
6. REQUIRED: Call validateWorkspace to check configuration
7. REQUIRED: Call exportWorkspace to finalize

You must create AT LEAST:
- 1 signal (trigger mechanism)
- 2 agents (workers to perform tasks)
- 1 job (connecting signals to agents)

Do NOT stop after calling just initializeWorkspace. Continue calling tools until you have a complete, functional workspace with all components.

Begin construction now and call ALL necessary tools.`;

    return prompt;
  }

  private getTemperatureForAttempt(attempt: number): number {
    // Progressive temperature reduction: 0.4 → 0.3 → 0.2
    return Math.max(0.1, 0.5 - (attempt - 1) * 0.1);
  }

  private getLastErrors(): string[] | undefined {
    const lastAttempt = this.attemptHistory[this.attemptHistory.length - 1];
    return lastAttempt?.errors || (lastAttempt?.error ? [lastAttempt.error] : undefined);
  }

  private buildSuccessReasoning(
    attempt: number,
    finalText?: string,
    thinking?: string,
    toolCalls?: string[],
  ): string {
    let reasoning = `## Workspace Generation Summary\n\n`;

    if (attempt === 1) {
      reasoning += `✅ **Success**: Generated on first attempt\n\n`;
    } else {
      reasoning +=
        `✅ **Success**: Generated after ${attempt} attempts (previous attempts had validation issues)\n\n`;
    }

    if (toolCalls && toolCalls.length > 0) {
      reasoning += `🔧 **Tool Execution**: ${toolCalls.join(" → ")}\n\n`;
    }

    if (thinking && thinking.length > 0) {
      reasoning += `🧠 **AI Reasoning Process**:\n\n${thinking.trim()}\n\n`;
    }

    if (finalText && finalText.length > 0) {
      reasoning += `💬 **Final Output**:\n\n${finalText.trim()}`;
    }

    return reasoning;
  }

  private buildFailureMessage(maxAttempts: number): string {
    const allErrors = this.attemptHistory.flatMap((h) => h.errors || (h.error ? [h.error] : []));

    return `Failed to generate valid workspace after ${maxAttempts} attempts. Errors encountered:\n${
      allErrors.map((error, i) => `${i + 1}. ${error}`).join("\n")
    }`;
  }

  // Helper method to get user-friendly error for the main tool
  getUserFriendlyError(error: unknown): string {
    if (error instanceof Error) {
      // Simplify technical errors for user consumption
      if (error.message.includes("validation")) {
        return "The workspace configuration had validation issues. Please try with different requirements.";
      }
      if (error.message.includes("tool")) {
        return "There was an issue with workspace construction. Please try again.";
      }
      return error.message;
    }
    return String(error);
  }
}
