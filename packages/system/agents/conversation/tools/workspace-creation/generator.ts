import { createAnthropic } from "@ai-sdk/anthropic";
import type { WorkspaceConfig } from "@atlas/config";
import { logger } from "@atlas/logger";
import { stepCountIs, streamText } from "ai";
import type { WorkspaceRequirements } from "./generation.ts";
import SYSTEM_PROMPT from "./prompt.txt" with { type: "text" };
import { workspaceBuilder, workspaceBuilderTools } from "./tools.ts";

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
    this.anthropic = createAnthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY") });
  }

  async generateWorkspace(
    userIntent: string,
    conversationContext?: string,
    requirements?: WorkspaceRequirements,
    maxAttempts: number = 3,
  ): Promise<GenerationResult> {
    this.attemptHistory = [];
    const builder = workspaceBuilder();

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      logger.info(`Starting workspace generation attempt ${attempt}/${maxAttempts}`);

      try {
        // Reset workspace builder for fresh attempt
        logger.debug("Resetting workspace builder");
        builder.reset();

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

        const result = streamText({
          model: this.anthropic("claude-sonnet-4-20250514"),
          system: SYSTEM_PROMPT,
          prompt,
          maxOutputTokens: 8000,
          tools: workspaceBuilderTools,
          stopWhen: stepCountIs(60),
          maxRetries: 3, // Enable retries for API resilience (e.g., 529 errors)
          providerOptions: { anthropic: { thinking: { type: "enabled", budgetTokens: 7000 } } },
        });

        const [text, reasoning, toolCalls] = await Promise.all([
          result.text,
          result.reasoningText,
          result.toolCalls,
        ]);

        const calledToolNames = toolCalls.map((t) => t.toolName);

        const aiEndTime = Date.now();
        const totalAiTime = aiEndTime - aiStartTime;

        logger.debug(`AI generation completed in ${totalAiTime}ms`);
        logger.debug(`Tool execution sequence: ${calledToolNames.join(" → ")}`);

        // Check if we have minimum components for a functional workspace
        logger.debug("Analyzing generated workspace components");
        let hasMinimumComponents = false;
        let signalCount = 0,
          agentCount = 0,
          jobCount = 0;
        try {
          const config = builder.exportConfig();
          signalCount = Object.keys(config.signals || {}).length;
          agentCount = Object.keys(config.agents || {}).length;
          jobCount = Object.keys(config.jobs || {}).length;

          logger.debug(
            `Workspace components: ${signalCount} signals, ${agentCount} agents, ${jobCount} jobs`,
          );
          // NOTE: atlas-platform is injected at runtime, not part of workspace config
          hasMinimumComponents = signalCount >= 1 && agentCount >= 1 && jobCount >= 1;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.debug(`Failed to export config: ${errorMessage}`);
          hasMinimumComponents = false;
        }

        // Only validate if we have minimum components, otherwise force failure
        logger.debug("Running workspace validation");
        const validation = hasMinimumComponents
          ? builder.validateWorkspace()
          : {
              success: false,
              errors: ["Workspace incomplete - missing signals, agents, or jobs"],
              warnings: [],
            };

        if (validation.success) {
          logger.info(`Workspace generation attempt ${attempt} succeeded`);
          const config = builder.exportConfig();
          logger.debug(
            `Generated workspace with ${signalCount} signals, ${agentCount} agents, ${jobCount} jobs`,
          );

          return {
            config,
            reasoning: this.buildSuccessReasoning(attempt, text, reasoning, calledToolNames),
          };
        }

        // Record validation failure
        logger.debug(`Attempt ${attempt} failed validation: ${validation.errors.join(", ")}`);
        this.attemptHistory.push({ attempt, errors: validation.errors });
      } catch (error) {
        // Record execution error
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.debug(`Attempt ${attempt} threw error: ${errorMessage}`);
        this.attemptHistory.push({ attempt, error: errorMessage });
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

**AGENT TOOL USAGE**:
- ALL agents automatically have access to atlas-platform tools
- You don't need to list specific tools in prompts - agents can discover and use them as needed
- Focus agent prompts on WHAT they should do, not HOW (tools will be selected automatically)
- For critical operations (like email), you can still use tool_choice: "required" to ensure tools are used

**ANTI-HALLUCINATION SAFEGUARDS**:
- YOU are responsible for identifying data-fetching agents and enhancing their prompts
- Data-fetching agents (prices, stocks, articles, weather, etc.) must include anti-hallucination instructions in their prompts
- See the system prompt for specific anti-hallucination instructions to add to data-fetching agent prompts
- Content creation agents (blog writers, email composers) do not need anti-hallucination enhancements

1. REQUIRED: Call initializeWorkspace first
2. REQUIRED: Call addScheduleSignal OR addWebhookSignal for triggers
3. REQUIRED: Call addLLMAgent AND/OR addRemoteAgent for workers
4. REQUIRED: Call createJob to connect signals to agents
5. REQUIRED: Call discoverAndAddMCPServers if external integrations are needed (identify requirements first)
6. OPTIONAL: Call addMCPIntegration only if discovery doesn't find suitable servers
7. REQUIRED: Call validateWorkspace to check configuration
8. REQUIRED: Call exportWorkspace to finalize

You must create AT LEAST:
- 1 signal (trigger mechanism)
- 2 agents (workers to perform tasks)
- 1 job (connecting signals to agents)

**CRITICAL for Email Workflows**: If the user wants email notifications, you MUST:
1. Create an email report agent as the last agent in the pipeline
2. Configure the email agent with tool_choice: "required" to ensure tools are used
3. Use a natural prompt focused on the task, not specific tools
4. Example configuration:
   - prompt: "You are responsible for sending email notifications. Format and send an email report with the analysis results to the configured recipients."
   - tool_choice: "required" (ensures the agent uses tools to send email)

**MANDATORY MCP DISCOVERY**: You MUST use MCP discovery for any external integrations:
1. BEFORE adding any manual MCP integrations, call 'discoverAndAddMCPServers'
2. Extract requirements from user intent (e.g., ['GitHub API access', 'Discord notifications'])
3. Only use manual 'addMCPIntegration' if discovery fails to find suitable servers
4. This ensures consistent registry usage across all workspace creation paths

**IMPORTANT: Atlas Platform Tools**
All Atlas platform tools are automatically available to ALL agents at runtime. You do NOT need to:
- Add atlas-platform as an MCP server
- Include "atlas-platform" in agent tools arrays
- Mention specific tool names in agent prompts

Agents can discover and use Atlas tools automatically based on their task requirements.

**ATLAS TOOLS AUTOMATICALLY AVAILABLE:**
- **Web Research**:
  - targeted_research - Multi-query search, extraction, synthesis
- **File operations**: atlas_read, atlas_write, atlas_ls, atlas_glob, atlas_grep
- **Email notifications**: atlas_notify_email
- **System commands**: atlas_bash
- **Data persistence**: atlas_library_store, atlas_library_get, atlas_library_list
- **Workspace management**: atlas_workspace_*, atlas_session_*, atlas_jobs_*

**AVOID EXTERNAL MCP** if Atlas tools can handle the requirement:
- DON'T add GitHub MCP if atlas_fetch can call GitHub API
- DON'T add filesystem MCP if atlas_read/atlas_write sufficient
- DON'T add email MCP if atlas_notify_email sufficient

Do NOT stop after calling just initializeWorkspace. Continue calling tools until you have a complete, functional workspace with all components.

Begin construction now and call ALL necessary tools.`;

    return prompt;
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
      reasoning += `✅ **Success**: Generated after ${attempt} attempts (previous attempts had validation issues)\n\n`;
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

    return `Failed to generate valid workspace after ${maxAttempts} attempts. Errors encountered:\n${allErrors
      .map((error, i) => `${i + 1}. ${error}`)
      .join("\n")}`;
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
