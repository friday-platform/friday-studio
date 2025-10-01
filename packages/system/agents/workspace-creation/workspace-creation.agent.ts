import { anthropic } from "@atlas/core";
import { createAgent } from "@atlas/agent-sdk";
import type { WorkspaceConfig } from "@atlas/config";
import type { Logger } from "@atlas/logger";
import { createAtlasClient } from "@atlas/oapi-client";
import { generateText, hasToolCall, stepCountIs, streamText } from "ai";
import { WorkspaceBuilder, type WorkspaceSummary } from "./builder.ts";
import { getWorkspaceBuilderTools } from "./tools.ts";

type WorkspaceResult = {
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
Execute this sequence:

1. ANALYZE user requirements internally - understand what they want to accomplish:
   - What triggers the automation? (time-based vs event-based)
   - What data sources are involved? (APIs, websites, databases)
   - What processing is needed? (analysis, transformation, filtering)
   - Where should results go? (notifications, databases, other APIs)
   - CRITICAL: Extract specific destinations (Slack channels, email addresses)

2. SET workspace identity using your analysis

3. GENERATE Agents and Signals IN PARALLEL:
   - Decompose requirements into distinct agent responsibilities
   - CRITICAL: Include destination specifics in agent requirements
   - For Slack agents: "Send updates to Slack channel #channel-name"
   - Describe what each agent needs to accomplish (not how)
   - Call generateAllAgents AND generateSignals in parallel (they're independent)
   - CRITICAL: Verify BOTH operations succeeded before proceeding


4. GENERATE Jobs and MCP Servers in PARALLEL:
   - Generate jobs connecting signals to agents
   - call generateJobs and generateMcpServers in parallel
   - Generate MCP servers for agent tool requirements - do this before validating

6. VALIDATE and fix:
   - Validate workspace
   - If validation shows missing components, regenerate them
   - Retry validation after fixes
   - Export only after successful validation
</workflow>

<agent_requirement_format>
  When preparing agent requirements for generateAllAgents, describe each as:
  - A clear statement of what the agent needs to accomplish
  - Focus on the task outcome, not implementation method
  - Be specific about the data source and desired output

Examples:
  - "Extract meeting notes and action items from PDF files in specified directory"
  - "Monitor GitHub PRs for review requests and post summaries to Slack channel #engineering"
</agent_requirement_format>

<agent_decomposition_examples>
  Bad: One agent that reads files, analyzes content, and posts to Slack
  Good: Three agents - file reader, content analyzer, slack notifier

  Bad: One agent that fetches API data, transforms it, and saves to database
  Good: Three agents - API fetcher, data transformer, database writer

  Task: "Monitor Reddit for product mentions and summarize"
  Bad: Three agents - reddit scraper, mention analyzer, report generator
  Good: One or two agents - research agent (handles search + summary), optional notifier
</agent_decomposition_examples>

<critical_requirements>
- You are running headless. Only call tools, don't output text.
- NEVER use a tool for requirements analysis - analyze requirements using your reasoning
- Think intent first, implementation second - understand what user wants to accomplish
- Follow single-responsibility principle - each agent should do ONE thing well
- Ensure signal/agent/job coherence - every signal must trigger jobs, every job needs agents
- VERIFY batch operations completed - check return values show all agents created
- When validation fails, review what's missing and regenerate if needed
- Fail fast on validation errors - regenerate problematic components immediately
</critical_requirements>


Current datetime (UTC): ${new Date().toISOString()}`;

/**
 * Generates human-readable progress messages for workspace creation tools
 */
async function generateProgressMessage(
  toolName: string,
  toolArgs: unknown,
  fallback: string,
  logger?: Logger,
  abortSignal?: AbortSignal,
): Promise<string> {
  try {
    const contextStr = typeof toolArgs === "string" ? toolArgs : JSON.stringify(toolArgs, null, 2);

    const toolContexts: Record<string, string> = {
      setWorkspaceIdentity: `Extract workspace name and description.
Examples:
- "Configuring data pipeline"
- "Creating automation workspace"`,

      generateAllAgents: `Extract agent types and count being created.
Examples:
- "Adding 3 agents"
- "Building monitoring agent"
- "Generating data processors"`,

      generateSignals: `Extract signal trigger type(s).
Examples:
- "Adding webhook trigger"
- "Configuring schedule"
- "Adding file system watcher"`,

      generateJobs: `Extract job connections being made.
Examples:
- "Connecting agents"
- "Creating job pipelines"`,

      generateMCPServers: `Extract MCP tool types.
Examples:
- "Adding MCP servers"
- "Adding filesystem access"`,

      validateWorkspace: `Extract what's being validated.
Examples:
- "Validating..."`,

      exportWorkspace: `Note final export.
Examples:
- "Exporting configuration"
- "Finalizing setup"
- "Saving configuration"`,

      removeJob: `Extract what's being removed.
Examples:
- "Removing duplicate job"
- "Deleting invalid connection"
- "Cleaning job configuration"`,

      getSummary: `Note summary generation.
Examples:
- "Generating workspace summary"
- "Creating configuration overview"
- "Building workspace report"`,
    };

    const guidance = toolContexts[toolName] || "Generate a status update for this operation";

    const { text } = await generateText({
      model: anthropic("claude-3-5-haiku-latest"),
      abortSignal,
      system: `Generate a workspace creation progress update.

<constraints>
- Maximum 3 words
- Start with capital letter
- Be specific about WHAT is being created/configured
- Should usually follow the format [verb] [count(optional)] [noun]
- No generic phrases - don't overuse "workspace" or "workflow"
</constraints>

<tool_guidance>
${guidance}
</tool_guidance>`,
      prompt: `<tool>${toolName}</tool>

<context>
${contextStr.slice(0, 500)}
</context>

<task>
Generate a specific progress update. Focus on the actual workspace elements being created.
Return ONLY the progress text, no explanations.
</task>`,
      temperature: 0.5,
      maxOutputTokens: 50,
    });

    return text.trim();
  } catch (error) {
    logger?.warn(`Failed to generate progress message`, {
      error: error instanceof Error ? error.message : String(error),
      tool: toolName,
    });
    return fallback;
  }
}

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
        model: anthropic("claude-3-5-haiku-latest"),
        system: SYSTEM_PROMPT,
        prompt: `Create an Atlas workspace for this automation requirement: ${prompt}`,
        tools,
        stopWhen: [stepCountIs(20), hasToolCall("exportWorkspace")],
        maxRetries: 3,
        maxOutputTokens: 4096,
        abortSignal,
        experimental_telemetry: telemetry,
        onStepFinish: ({ reasoningText, text }) => {
          logger.debug(`Step completed:

            Text: ${text}
            Reasoning: ${reasoningText}
            `);
        },
        onChunk: async ({ chunk }) => {
          if (chunk.type === "tool-call") {
            logger.debug(`Executing tool: ${chunk.toolName}`, { chunk: chunk });

            // Extract tool arguments - the chunk itself contains the tool call data
            const toolArgs = "input" in chunk ? chunk.input : chunk;

            const progressMessage = await generateProgressMessage(
              chunk.toolName,
              toolArgs,
              `Executing ${chunk.toolName}...`,
              logger,
              abortSignal,
            );

            stream?.emit({
              type: "data-tool-progress",
              data: { toolName: "Workspace Creator", content: progressMessage },
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
