import { createAnthropic } from "@ai-sdk/anthropic";
import type { WorkspaceConfig } from "@atlas/config";
import { logger } from "@atlas/logger";
import type { WorkspaceEntry } from "@atlas/workspace";
import { getWorkspaceManager } from "@atlas/workspace";
import { stepCountIs, streamText } from "ai";
import { WorkspaceBuilder } from "../workspace-creation/builder.ts";
import SYSTEM_PROMPT from "./prompt.txt" with { type: "text" };
import { initializeUpdateBuilder, workspaceUpdateTools } from "./tools.ts";

interface AttemptResult {
  attempt: number;
  errors?: string[];
  error?: string;
}

interface UpdateResult {
  config: WorkspaceConfig;
  reasoning: string;
  workspace: WorkspaceEntry;
}

export class WorkspaceUpdater {
  private anthropic: ReturnType<typeof createAnthropic>;
  private attemptHistory: AttemptResult[] = [];

  constructor() {
    this.anthropic = createAnthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY") });
  }

  async updateWorkspace(
    workspaceIdentifier: string,
    userIntent: string,
    conversationContext?: string,
    maxAttempts: number = 3,
  ): Promise<UpdateResult> {
    this.attemptHistory = [];

    // Step 1: Resolve and load existing workspace
    logger.info(`Resolving workspace: ${workspaceIdentifier}`);
    const workspace = await this.resolveWorkspace(workspaceIdentifier);
    if (!workspace) {
      throw new Error(`Workspace not found: ${workspaceIdentifier}`);
    }

    logger.info(`Loading workspace configuration: ${workspace.name}`, { id: workspace.id });
    const workspaceManager = await getWorkspaceManager();
    const mergedConfig = await workspaceManager.getWorkspaceConfig(workspace.id);
    if (!mergedConfig) {
      throw new Error(`Failed to load workspace configuration: ${workspace.id}`);
    }

    const existingConfig = mergedConfig.workspace;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      logger.info(`Starting workspace update attempt ${attempt}/${maxAttempts}`);

      try {
        // Step 2: Initialize WorkspaceBuilder with existing configuration
        logger.debug("Initializing workspace builder with existing configuration");
        const builder = new WorkspaceBuilder(existingConfig);

        // Initialize the singleton builder for tools to use
        initializeUpdateBuilder(builder);

        // Step 3: Execute update loop
        logger.debug(`Building update prompt for attempt ${attempt}`);
        const prompt = this.buildUpdatePrompt(
          userIntent,
          attempt,
          conversationContext,
          this.getLastErrors(),
          existingConfig,
        );

        // Use streamText to capture real-time thinking and tool calls
        const aiStartTime = Date.now();
        logger.info("Starting AI workspace update with Claude Sonnet 4");

        let capturedThinking = "";
        const toolCallSummary: string[] = [];
        let finalText = "";

        const result = streamText({
          model: this.anthropic("claude-sonnet-4-20250514"),
          system: SYSTEM_PROMPT,
          prompt,
          maxOutputTokens: 8000,
          tools: workspaceUpdateTools,
          stopWhen: stepCountIs(40),
          maxRetries: 3, // Enable retries for API resilience (e.g., 529 errors)
          providerOptions: { anthropic: { thinking: { type: "enabled", budgetTokens: 7000 } } },
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

        logger.debug(`AI update generation completed in ${totalAiTime}ms`);
        logger.debug(`Tool execution sequence: ${toolCallSummary.join(" → ")}`);

        // Step 4: Validate the updated workspace
        logger.debug("Running workspace validation");
        const validation = builder.validateWorkspace();

        if (validation.success) {
          logger.info(`Workspace update attempt ${attempt} succeeded`);
          const updatedConfig = builder.exportConfig();

          return {
            config: updatedConfig,
            workspace,
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
        this.attemptHistory.push({ attempt, errors: validation.errors });
      } catch (error) {
        // Record execution error
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.debug(`Attempt ${attempt} threw error: ${errorMessage}`);
        this.attemptHistory.push({ attempt, error: errorMessage });
      }
    }

    // All attempts failed
    logger.info(`Workspace update failed after ${maxAttempts} attempts`);
    throw new Error(this.buildFailureMessage(maxAttempts));
  }

  private async resolveWorkspace(identifier: string): Promise<WorkspaceEntry | null> {
    const workspaceManager = await getWorkspaceManager();

    // Try ID first (most specific)
    let workspace = await workspaceManager.find({ id: identifier });
    if (workspace) return workspace;

    // Try name (user-friendly)
    workspace = await workspaceManager.find({ name: identifier });
    if (workspace) return workspace;

    // Try path (context-aware)
    workspace = await workspaceManager.find({ path: identifier });
    if (workspace) return workspace;

    return null;
  }

  private buildUpdatePrompt(
    userIntent: string,
    attempt: number,
    conversationContext?: string,
    lastErrors?: string[],
    existingConfig?: WorkspaceConfig,
  ): string {
    let prompt = `# Workspace Update Request

**User Intent**: ${userIntent}`;

    if (conversationContext) {
      prompt += `\n\n**Conversation Context**: ${conversationContext}`;
    }

    if (existingConfig) {
      prompt += `\n\n**Current Workspace Configuration**:
- **Name**: ${existingConfig.workspace.name}
- **Description**: ${existingConfig.workspace.description || "No description"}
- **Signals**: ${Object.keys(existingConfig.signals || {}).length} configured
- **Agents**: ${Object.keys(existingConfig.agents || {}).length} configured
- **Jobs**: ${Object.keys(existingConfig.jobs || {}).length} configured
- **MCP Servers**: ${
        existingConfig.tools?.mcp?.servers
          ? Object.keys(existingConfig.tools.mcp.servers).length
          : 0
      } configured

**Existing Components**:
${this.formatExistingComponents(existingConfig)}`;
    }

    if (attempt > 1 && lastErrors?.length) {
      prompt += `\n\n## Previous Attempt Failed

**Attempt**: ${attempt}/${3}
**Previous Errors**:
${lastErrors.map((error) => `- ${error}`).join("\n")}

Please analyze these errors and adjust your approach accordingly.`;
    }

    prompt += `\n\n## Instructions

You are updating an EXISTING Atlas workspace. The WorkspaceBuilder has already been initialized with the current workspace configuration. Use the provided update tools to modify the workspace according to the user's intent.

**Available Update Operations**:
1. **listWorkspaceComponents** - Query current workspace state
2. **updateSignal** - Modify existing signal configuration
3. **updateAgent** - Modify existing agent configuration
4. **updateJob** - Modify existing job configuration
5. **removeSignal** - Remove signal and handle dependent jobs
6. **removeAgent** - Remove agent and update job references
7. **removeJob** - Remove job safely
8. **addScheduleSignal** / **addWebhookSignal** - Add new signals if needed
9. **addLLMAgent** / **addRemoteAgent** - Add new agents if needed
10. **createJob** - Add new jobs if needed
11. **validateWorkspace** - Check configuration integrity
12. **exportWorkspace** - Finalize the updated configuration

**Update Strategy**:
- Start by understanding the current workspace with **listWorkspaceComponents**
- Make targeted modifications based on user intent
- Preserve existing functionality unless explicitly asked to remove it
- Validate reference integrity after modifications
- Always call **validateWorkspace** before **exportWorkspace**

**Important Notes**:
- Only modify what the user specifically requested
- Maintain existing component relationships unless explicitly changed
- If adding new components, ensure they integrate properly with existing ones
- If removing components, handle dependent references appropriately
- **For Email Notifications**: When updating agents that send emails, ensure their prompts explicitly instruct them to CALL atlas_notify_email with the report content - don't just have them "format for email"
- **CRITICAL FOR VALUE UPDATES**: When changing values like email addresses, URLs, or names - ALWAYS check and update ALL occurrences across ALL fields (description, prompt, config, etc.). For agents, this means updating BOTH the description AND prompt fields if the value appears in both

Begin the update process now.`;

    return prompt;
  }

  private formatExistingComponents(config: WorkspaceConfig): string {
    let output = "";

    // Format signals
    if (config.signals && Object.keys(config.signals).length > 0) {
      output += "\n**Signals**:\n";
      for (const [id, signal] of Object.entries(config.signals)) {
        output += `- ${id}: ${signal.type} signal\n`;
      }
    }

    // Format agents
    if (config.agents && Object.keys(config.agents).length > 0) {
      output += "\n**Agents**:\n";
      for (const [id, agent] of Object.entries(config.agents)) {
        output += `- ${id}: ${agent.type} agent\n`;
      }
    }

    // Format jobs
    if (config.jobs && Object.keys(config.jobs).length > 0) {
      output += "\n**Jobs**:\n";
      for (const [id, job] of Object.entries(config.jobs)) {
        output += `- ${id}: connects ${job.signal} → ${job.agent}\n`;
      }
    }

    return output || "\nNo existing components found.";
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
    let reasoning = `## Workspace Update Summary\n\n`;

    if (attempt === 1) {
      reasoning += `✅ **Success**: Updated on first attempt\n\n`;
    } else {
      reasoning += `✅ **Success**: Updated after ${attempt} attempts (previous attempts had validation issues)\n\n`;
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

    return `Failed to update workspace after ${maxAttempts} attempts. Errors encountered:\n${allErrors
      .map((error, i) => `${i + 1}. ${error}`)
      .join("\n")}`;
  }

  // Helper method to get user-friendly error for the main tool
  getUserFriendlyError(error: unknown): string {
    if (error instanceof Error) {
      // Simplify technical errors for user consumption
      if (error.message.includes("validation")) {
        return "The workspace update had validation issues. Please try with different modifications.";
      }
      if (error.message.includes("tool")) {
        return "There was an issue with workspace modification. Please try again.";
      }
      if (error.message.includes("not found")) {
        return "The specified workspace could not be found. Please check the workspace identifier.";
      }
      return error.message;
    }
    return String(error);
  }
}
