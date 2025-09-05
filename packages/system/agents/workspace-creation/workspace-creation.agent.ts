
import { anthropic } from "@ai-sdk/anthropic";
import { createAgent } from "@atlas/agent-sdk";
import type { WorkspaceConfig } from "@atlas/config";
import { createAtlasClient } from "@atlas/oapi-client";
import { stepCountIs, streamText } from "ai";
import { WorkspaceBuilder, type WorkspaceSummary } from "./builder.ts";
import { getWorkspaceBuilderTools } from "./tools.ts";

export type WorkspaceResult = {
  success: true;
  workspaceName: string;
  workspacePath?: string;
  config: WorkspaceConfig;
  summary: WorkspaceSummary;
};

const SYSTEM_PROMPT = `<role>
You create Atlas workspaces by translating automation requirements into working configurations.
</role>

<context>
Atlas workspaces connect triggers to AI agents through jobs. Each workspace creates automation pipelines where:

- Signals: Triggers from external events (webhooks, schedules)
- Agents: AI executors that process data and perform actions
- Jobs: Orchestration logic connecting signals to agents
- Tools: MCP servers providing agent capabilities (APIs, file systems, notifications)

You turn user requirements into working automation systems.
</context>

<workflow>
Execute this sequence with proper verification:

1. ANALYZE user requirements internally - understand what they want to accomplish:
   - What triggers the automation? (time-based vs event-based)
   - What data sources are involved? (APIs, websites, databases)
   - What processing is needed? (analysis, transformation, filtering)
   - Where should results go? (notifications, databases, other APIs)

2. SET workspace identity using your analysis

3. GENERATE components with verification:
   - Create one agent per responsibility (data extraction, analysis, notification)
   - Create signals for triggers
   - Call generateAgent for each responsibility
   - CRITICAL: Verify each agent was created successfully by checking the return value
   - If any agent fails, retry that specific agent generation before proceeding
   - DO NOT proceed to jobs until all required agents exist

4. ORCHESTRATE workflows:
   - VERIFY all agents exist using getSummary before generating jobs
   - Generate jobs connecting signals to agents
   - If job references missing agents, generate those agents first

5. ADD MCP servers:
   - Generate MCP servers for agent tool requirements - do this before validating

6. VALIDATE and fix:
   - Validate workspace
   - If validation shows missing agents, generate them specifically
   - If validation shows job errors, check for missing agents first
   - Retry validation after fixes
   - Export only after successful validation

CRITICAL: When calling tools in parallel, ALWAYS verify all operations succeeded before proceeding. Check return values and summary counts.
</workflow>

<agent_decomposition_examples>
❌ Bad: One agent that reads files, analyzes content, and posts to Slack
✅ Good: Three agents - file reader, content analyzer, slack notifier

❌ Bad: One agent that fetches API data, transforms it, and saves to database
✅ Good: Three agents - API fetcher, data transformer, database writer
</agent_decomposition_examples>

<critical_requirements>
- NEVER use a tool for requirements analysis - analyze requirements using your reasoning
- Think intent first, implementation second - understand what user wants to accomplish
- Follow single-responsibility principle - each agent should do ONE thing well (read files OR analyze content OR send notifications, not multiple)
- Use multiple focused agents instead of one big agent
- Generate only what's needed, but properly decomposed
- Ensure signal/agent/job coherence - every signal must trigger jobs, every job needs agents
- VERIFY parallel operations completed - check return values and use getSummary to confirm counts
- When validation fails with missing agents, regenerate the agents NOT the jobs
- Fail fast on validation errors - regenerate problematic components immediately
- Check agent generation success before proceeding to job generation
</critical_requirements>

Current datetime (UTC): ${new Date().toISOString()}`;

/**
 * Creates Atlas workspaces from automation requirements.
 * Analyzes user input and generates signal triggers, AI agents, orchestration jobs, and tool configurations.
 */
export const workspaceCreationAgent = createAgent<WorkspaceResult>({
  id: "workspace-creation",
  displayName: "Workspace Creation Agent",
  version: "2.0.0",
  description: "Creates Atlas workspaces from automation requirements",

  expertise: { domains: ["Atlas workspaces"], examples: [] },

  handler: async (prompt, { logger, stream, abortSignal, telemetry }) => {
    const builder = new WorkspaceBuilder();
    const tools = getWorkspaceBuilderTools(builder, logger, abortSignal);

    logger.info("Starting workspace generation");

    try {
      const result = streamText({
        model: anthropic("claude-sonnet-4-20250514"),
        system: SYSTEM_PROMPT,
        prompt: `Create an Atlas workspace for this automation requirement:

        ${prompt}

        Analyze what the user wants to accomplish, then build a complete workspace configuration.`,
        tools,
        stopWhen: stepCountIs(15),
        maxRetries: 3,
        maxOutputTokens: 25000,
        abortSignal,
        experimental_telemetry: telemetry,
        providerOptions: { anthropic: { thinking: { type: "enabled", budgetTokens: 25000 } } },
        onStepFinish: ({ reasoningText, text }) => {
          logger.debug(`Step completed:

            Text: ${text}
            Reasoning: ${reasoningText}
            `);
        },
        onChunk: ({ chunk }) => {
          if (chunk.type === "tool-call") {
            logger.debug(`Executing tool: ${chunk.toolName}`, { chunk: chunk });
            stream?.emit({
              type: "data-tool-progress",
              data: { toolName: "Workspace Creator", content: `Executing ${chunk.toolName}...` },
            });
          }
        },
      });

      await result.text;

      const config = builder.exportConfig();
      const summary = builder.getSummary();

      const client = createAtlasClient();
      const response = await client.POST("/api/workspaces/create", {
        body: { config, workspaceName: config.workspace.name },
      });

      if (response.error) {
        throw new Error(
          `API error (${response.response.status}): ${JSON.stringify(response.error)}`,
        );
      }

      return {
        success: true,
        workspaceName: config.workspace.name,
        workspacePath: response.data.workspacePath,
        config,
        summary,
      };
    } catch (error) {
      logger.error("Workspace generation failed", { error });
      throw error;
    }
  },
});
