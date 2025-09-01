/**
 * Conversation Agent - SDK Architecture Implementation
 *
 * Interactive conversation agent for workspace collaboration with:
 * - Persistent conversation history via daemon storage
 * - Tool execution through MCP server
 * - Real-time streaming responses
 * - Task tracking with todos
 */

import { anthropic } from "@ai-sdk/anthropic";
import { createAgent, type StreamEmitter } from "@atlas/agent-sdk";
import type { WorkspaceConfig } from "@atlas/config";
import type { Logger } from "@atlas/logger";
import { createAtlasClient } from "@atlas/oapi-client";
import { stringifyError } from "@atlas/utils";
import { stepCountIs, streamText } from "ai";
import SYSTEM_PROMPT from "./prompt.txt" with { type: "text" };
import type { ValidationResult } from "./tools/builder.ts";
import { getWorkspaceBuilderTools, WorkspaceBuilder } from "./tools/mod.ts";

function getSystemPrompt() {
  return `${SYSTEM_PROMPT}

  Current datetime (UTC): ${new Date().toISOString()}
  `;
}

type WorkspaceConfigInput = {
  prompt: string;
  maxAttempts?: number;
  logger: Logger;
  stream?: StreamEmitter;
  abortSignal?: AbortSignal;
};

async function generateWorkspaceConfig({
  prompt,
  maxAttempts = 3,
  stream,
  logger,
  abortSignal,
}: WorkspaceConfigInput): Promise<WorkspaceConfig> {
  const builder = new WorkspaceBuilder();
  const workspaceTools = getWorkspaceBuilderTools(builder);
  const pastAttemptErrors: string[] = [];

  function buildAttemptPrompt(userIntent: string, pastErrors: string[]): string {
    const prompt = `# Workspace Generation Request
      **User Intent**: ${userIntent}
      `;

    if (pastErrors.length > 0) {
      prompt.concat(`\n\n## Previous Attempt Failed

      **Previous Errors**:
      ${pastErrors.map((error) => `- ${error}`).join("\n")}

      Please analyze these errors and adjust your approach accordingly.`);
    }

    return prompt;
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    logger.info(`Starting workspace generation attempt ${attempt}/${maxAttempts}`);

    try {
      // Reset workspace builder for fresh attempt
      builder.reset();

      const res = streamText({
        model: anthropic("claude-sonnet-4-20250514"),
        system: getSystemPrompt(),
        prompt: buildAttemptPrompt(prompt, pastAttemptErrors),
        maxOutputTokens: 20000,
        tools: workspaceTools,
        stopWhen: stepCountIs(60),
        temperature: 0.3,
        maxRetries: 3, // Enable retries for API resilience (e.g., 529 errors)
        providerOptions: { anthropic: { thinking: { type: "enabled", budgetTokens: 25000 } } },
        abortSignal,
        onChunk: ({ chunk }) => {
          if (chunk.type === "tool-call") {
            logger.debug(`Tool call: ${chunk.toolName}`);
          }
        },
      });

      // Wait for the LLM to complete.
      await res.text;

      // Check if we have minimum components for a functional workspace
      let hasMinimumComponents = false;
      let signalCount = 0;
      let agentCount = 0;
      let jobCount = 0;

      const config = builder.exportConfig();
      signalCount = Object.keys(config.signals || {}).length;
      agentCount = Object.keys(config.agents || {}).length;
      jobCount = Object.keys(config.jobs || {}).length;
      hasMinimumComponents = signalCount >= 1 && agentCount >= 1 && jobCount >= 1;

      let validation: ValidationResult;
      if (!hasMinimumComponents) {
        validation = {
          success: false,
          errors: ["Workspace incomplete - missing signals, agents, or jobs"],
          warnings: [],
        };
      } else {
        validation = builder.validateWorkspace();
      }

      if (validation.success) {
        return config;
      }

      // Record validation failure
      logger.debug(`Attempt ${attempt} failed validation: ${validation.errors.join(", ")}`);
      pastAttemptErrors.push(...validation.errors);
    } catch (error) {
      logger.debug(`Attempt ${attempt} threw error`, { error });
      pastAttemptErrors.push(stringifyError(error));
    }
  }
  // All attempts failed
  throw new Error(`Failed to generate valid workspace after ${maxAttempts} attempts.`);
}

// Export the agent
export const workspaceCreationAgent = createAgent({
  id: "workspace-creation",
  displayName: "Workspace Creation Agent",
  version: "1.0.0",
  description: "Interactive workspace creation agent for workspace collaboration",

  expertise: { domains: ["workspaces"], capabilities: ["Creating Atlas Workspaces"], examples: [] },

  handler: async (prompt, { session, logger, abortSignal }) => {
    if (!session.streamId) {
      throw new Error("Stream ID is required");
    }

    const workspaceConfig = await generateWorkspaceConfig({ prompt, logger, abortSignal });
    const client = createAtlasClient();

    const response = await client.POST("/api/workspaces/create", {
      body: { config: workspaceConfig, workspaceName: workspaceConfig.workspace.name },
    });

    if (response.error) {
      throw new Error(`API error (${response.response.status}): ${JSON.stringify(response.error)}`);
    }

    return {
      success: true,
      workspaceName: workspaceConfig.workspace.name,
      workspacePath: response.data.workspacePath,
      summary: {
        signals: Object.keys(workspaceConfig.signals || {}).length,
        agents: Object.keys(workspaceConfig.agents || {}).length,
        jobs: Object.keys(workspaceConfig.jobs || {}).length,
        mcpServers: Object.keys(workspaceConfig.tools?.mcp?.servers || {}).length,
      },
    };
  },
});
