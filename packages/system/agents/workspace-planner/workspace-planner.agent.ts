import { createAgent, repairJson } from "@atlas/agent-sdk";
import { client, parseResult } from "@atlas/client/v2";
import type { CredentialBinding, WorkspacePlan } from "@atlas/core/artifacts";
import { bundledAgentsRegistry } from "@atlas/core/bundled-agents/registry";
import {
  type ClarificationItem,
  createAmbiguousBundledClarification,
  createAmbiguousMCPClarification,
  createBundledMissingFieldsClarification,
  createMCPMissingFieldsClarification,
  createNoMatchClarification,
  formatClarificationReport,
} from "@atlas/core/mcp-registry/clarification";
import {
  CredentialNotFoundError,
  resolveCredentialsByProvider,
} from "@atlas/core/mcp-registry/credential-resolver";
import {
  findUnmatchedNeeds,
  type MCPServerMatch,
  mapNeedToMCPServers,
  matchBundledAgents,
} from "@atlas/core/mcp-registry/deterministic-matching";
import { mcpServersRegistry } from "@atlas/core/mcp-registry/registry-consolidated";
import { validateRequiredFields } from "@atlas/core/mcp-registry/requirement-validator";
import { JSONSchemaSchema } from "@atlas/fsm-engine";
import { getDefaultProviderOpts, registry } from "@atlas/llm";
import type { Logger } from "@atlas/logger";
import { fail, getTodaysDate, type Result, stringifyError, success } from "@atlas/utils";
import { toKebabCase } from "@std/text";
import { generateObject, generateText } from "ai";
import { wrapAISDKModel } from "evalite/ai-sdk";
import { z } from "zod";
import { getCapabilitiesSection } from "../conversation/capabilities.ts";
import { fetchLinkSummary, formatIntegrationsSection } from "../conversation/link-context.ts";

/** Schema for workspace planner success data - exported for use in stop conditions */
export const WorkspacePlannerSuccessDataSchema = z.object({
  planSummary: z.string(),
  artifactId: z.string(),
  revision: z.number(),
  nextStep: z.string(),
});

type WorkspacePlannerResult = Result<
  z.infer<typeof WorkspacePlannerSuccessDataSchema>,
  { reason: string }
>;

const WorkspacePlannerInputSchema = z.object({
  intent: z.string().describe("Workspace requirements or modification request"),
  artifactId: z.string().optional().describe("Artifact ID to update (omit for new plans)"),
});

type WorkspacePlannerInput = z.infer<typeof WorkspacePlannerInputSchema>;

/**
 * Generates concise summaries via Haiku 4.5 for revision messages and plan summaries.
 */
async function summarize(params: {
  content: string;
  instruction: string;
  logger: Logger;
  abortSignal?: AbortSignal;
}): Promise<string> {
  const result = await generateText({
    model: wrapAISDKModel(registry.languageModel("anthropic:claude-haiku-4-5")),
    system:
      "You generate concise, accurate summaries. No fluff, no marketing speak. Direct and informative.",
    prompt: `
    ${params.instruction}

    Content:
    ${params.content}`,
    maxOutputTokens: 100,
    abortSignal: params.abortSignal,
  });

  params.logger.debug("AI SDK generateText completed", {
    agent: "workspace-planner",
    step: "summarize",
    usage: result.usage,
  });

  return result.text.trim();
}

const SYSTEM_PROMPT = `
You create workspace plans by analyzing user requirements and translating them into Atlas structure.

## Context

Atlas workspaces automate tasks using:
- Signals: Triggers (webhooks, schedules, file watchers)
- Agents: AI executors that process data and perform actions
- Jobs: Orchestration connecting signals to agents

## Signal Types

Each signal must have a signalType:

- **schedule**: Cron-based time triggers. Use for "every X", "daily at", "on weekdays", "hourly", or any time-based triggers.
  Examples: "every Friday at 9am", "every 30 minutes", "weekdays at 8am"

- **http**: Webhook/API endpoints. Use for "webhook", "API endpoint", "receives events", "HTTP POST", or external event triggers.
  Examples: "GitHub push webhook", "Stripe payment webhook", "manual trigger endpoint"

## Defining agents

Split agents by integration point and capability boundary:

Create SEPARATE agents for:
- Each distinct external system (calendar, email, Slack, GitHub are separate agents)
- Each distinct capability (research, analysis, notification, summarization are separate)
- Each integration point (one agent per API or service)

Combine into ONE agent only when:
- Same external system with multiple similar operations (one Slack agent handles all Slack posting)
- Parameterized targets for identical operations (monitoring multiple websites with same logic)

Examples:
- Good: Separate "Calendar Reader" + "Company Researcher" + "Email Sender" (distinct systems)
- Good: ONE "Website Monitor" with targets: ["Nike.com", "Adidas.com"] (same operation, different targets)
- Bad: ONE "Research + Email Agent" (mixes research capability with email integration)
- Bad: ONE "Calendar + Research + Email Pipeline" (bundles unrelated systems)

### Agent needs

The \`needs\` array lists external integrations (e.g., calendar, email, discord, sheets).
Use keywords from the available integrations list. Include ALL services the agent uses.

**IMPORTANT - Distinguish these capabilities:**
- "research" = web search for external information (news, company info, market data)
- "code-analysis" or "coding" = analyzing code repositories, debugging, finding root causes in codebases

Use "code-analysis" or "coding" when the task involves reading/analyzing source code, stack traces, or identifying bugs.
Use "research" only when searching the web for information external to the codebase.

### Agent configuration

The configuration field for an agent captures ONLY user-specific values:

Include:
- Channel/destination names: "#sneaker-drops", "vc@example.com"
- User-specified targets: ["Nike.com", "Adidas.com"]
- Explicit preferences from requirements: timezone if user mentioned it

DO NOT include:
- URL paths or endpoints
- Field extraction lists
- Intervals/frequencies (already in signal description)
- Data structures or technical specs
- Anything the agent can infer from requirements

**Example - Good:**
{
  "channel": "#sneakers",
  "targets": ["Nike.com", "Adidas.com"]
}

**Example - Bad:**
{
  "target_url": "https://www.nike.com/w/new-shoes",
  "check_interval": "30 minutes",
  "extract_fields": ["name", "price", "url"]
}

## Planning guidelines

- Identify what triggers the automation (time-based, event-based, manual)
- Split agents by external system and capability boundary
- Capture user-specific details in configuration (sparingly)
- Describe agents by WHAT they accomplish, not HOW (implementation)

## Output format

Generate structured plan with:
- workspace: name and purpose
- signals: trigger descriptions with rationale
- agents: purpose, approach, needs, configuration

## Writing guidelines

Focus on user intent and deliver maximum clarity in minimum words.

- Use clear, succinct prose, avoiding technical jargon.
- Use imperatives: "Returns X" not "This function returns X"
- No qualifiers: "might", "should", "basically", "essentially"
- No enterprise speak: "robust", "comprehensive", "leverage", "facilitate"
- Precision > politeness`;

export const workspacePlannerAgent = createAgent<WorkspacePlannerInput, WorkspacePlannerResult>({
  id: "workspace-planner",
  displayName: "Workspace Planner",
  version: "1.0.0",
  description:
    "Call when user requests workspace creation or modification. Analyzes requirements and generates a detailed workspace plan as an artifact. Returns planSummary and artifactId. For modifications, include existing artifactId to create a revision.",
  expertise: { domains: ["Atlas workspaces", "automation planning"], examples: [] },
  inputSchema: WorkspacePlannerInputSchema,

  /**
   * Two-phase LLM planning:
   * 1. Generate signals/agents → add kebab-case IDs programmatically
   * 2. Generate jobs with enum-constrained IDs to prevent hallucinated references
   */
  handler: async (input, { logger, stream, session, abortSignal }) => {
    logger.info("Starting workspace planning", { artifactId: input.artifactId });
    let existingPlan: WorkspacePlan | null = null;
    try {
      // Load existing plan if this is a revision
      if (input.artifactId) {
        logger.info("Loading existing plan for revision", { artifactId: input.artifactId });
        try {
          const response = await parseResult(
            client.artifactsStorage[":id"].$get({ param: { id: input.artifactId } }),
          );
          if (response.ok && response.data.artifact.data.type === "workspace-plan") {
            existingPlan = response.data.artifact.data.data;
            logger.info("Loaded existing plan for revision");
          }
        } catch (error) {
          logger.warn("Failed to load existing plan for revision", { error });
        }
      }

      // Fetch user's connected services
      const linkSummary = await fetchLinkSummary(logger);
      const integrationsXml = linkSummary
        ? formatIntegrationsSection(linkSummary)
        : "<integrations><!-- No OAuth services connected --></integrations>";

      // TODO: These progress events don't reach the UI - conversation agent lacks MCP notification handler.
      // The initial data-intent ("Creating plan") is emitted via onChunk in conversation.agent.ts instead.
      stream?.emit({
        type: "data-tool-progress",
        data: { toolName: "Workspace Planner", content: "Analyzing requirements" },
      });
      let signalsAndAgentsPrompt: string;
      if (existingPlan) {
        signalsAndAgentsPrompt = `
          Update this workspace plan based on new requirements. Make only the minimal changes necessary to meet the new requirements.
          Existing plan:
          ${JSON.stringify(existingPlan)}
          New requirements: ${input.intent}`;
      } else {
        signalsAndAgentsPrompt = `Create a workspace plan for these requirements:
    ${input.intent}
    Split agents by external system and capability boundary. Each agent should handle one integration point or one distinct capability.`;
      }
      // Generate workspace, signals, agents with LLM-chosen names
      const phase1Result = await generateObject({
        model: wrapAISDKModel(registry.languageModel("anthropic:claude-sonnet-4-5")),
        experimental_repairText: repairJson,
        schema: z.object({
          plan: z.object({
            workspace: z.object({
              name: z.string().describe("Workspace name (concise, human-readable)"),
              purpose: z
                .string()
                .describe(
                  "What this workspace does and how it works. 1-3 sentences. Focus on the task mechanics, not the value proposition. No marketing speak. Example: 'Fetches merged GitHub PRs from the past week every Friday at 9am and publishes a formatted, categorized summary to Notion.'",
                ),
              details: z
                .array(
                  z.object({
                    label: z
                      .string()
                      .describe(
                        "Human-readable label for the value. Examples: 'GitHub Repository', 'Slack Channel', 'Notion Database', 'Email Recipients'",
                      ),
                    value: z
                      .string()
                      .describe(
                        "The user-provided value. Examples: 'acme/webapp', '#engineering', 'Release Notes', 'team@company.com'",
                      ),
                  }),
                )
                .describe(
                  "User-provided details extracted from requirements. ONLY include human-readable values like repository names (org/repo), channel names (#channel), database/page names, email addresses. NEVER include: IDs, UUIDs, technical identifiers, timezones (shown in schedule), or credential info (shown in integrations). Omit if no specific values were provided.",
                ),
            }),
            signals: z.array(
              z.object({
                name: z
                  .string()
                  .describe(
                    "Human-readable signal name. Example: 'Check Schedule' or 'GitHub Push Event'",
                  ),

                title: z
                  .string()
                  .describe(
                    "Short verb-noun sentence for UI. Start with verb. Examples: 'Triggers daily at 10am PST', 'Receives GitHub push events', 'Watches for file changes'",
                  ),
                signalType: z
                  .enum(["schedule", "http"])
                  .describe(
                    "Signal provider type. 'schedule' for cron/time-based triggers, 'http' for webhooks/API endpoints.",
                  ),
                description: z
                  .string()
                  .describe(
                    "When and how this triggers, including rationale. 1-2 sentences. Examples: 'Runs every 30 minutes during business hours to catch new products quickly without overwhelming the website' or 'Webhook endpoint receives GitHub push events to trigger immediate CI builds'",
                  ),
                displayLabel: z
                  .string()
                  .describe(
                    "Short badge text for UI display. Examples: 'Every Friday at 9am', 'On GitHub push', 'Every 30 min', 'Manual trigger'. Maximum 5 words.",
                  ),
                payloadSchema: JSONSchemaSchema.optional().describe(
                  "JSON Schema for signal payload. Define if signal needs user input, file paths, or parameters. " +
                    "Required: array of field names. Properties: field definitions. " +
                    "Example: { type: 'object', required: ['user_input'], properties: { user_input: { type: 'string', description: 'User text input or description' } } }. " +
                    "Use snake_case for field names. Omit for schedule-only triggers. " +
                    "For fields that reference uploaded files or artifacts, add format: 'artifact-ref' to the field definition. " +
                    "Use type: 'string' with format: 'artifact-ref' for single artifact fields, or type: 'array' with items: { type: 'string', format: 'artifact-ref' } for multiple artifacts. " +
                    "Example: { file: { type: 'string', format: 'artifact-ref', description: 'Uploaded CSV file' } }. " +
                    "Only use artifact-ref for fields that carry artifact/file references — NOT for plain text inputs like user_input.",
                ),
              }),
            ),
            agents: z.array(
              z.object({
                name: z
                  .string()
                  .describe(
                    "Human-readable agent name. Example: 'Nike Website Monitor' or 'Discord Notifier'",
                  ),
                description: z
                  .string()
                  .describe(
                    "What this agent accomplishes and how it works. 1-2 sentences. Example: 'Monitors Nike.com product catalog by scraping product pages and comparing against known items to identify new shoe releases'",
                  ),
                needs: z
                  .array(z.string())
                  .describe(
                    "What this agent needs beyond built-in capabilities (webfetch, artifacts). Use [] if built-in capabilities are enough. File ops, bash, and csv require explicit MCP config. List service integrations (e.g., slack, github, email) or specialized capabilities. IMPORTANT: Use 'data-analysis' or 'sql' for analyzing datasets, database artifacts, CSV files, or producing reports from tabular data. Use 'code-analysis' or 'coding' for analyzing code/debugging/root-cause analysis. Use 'research' ONLY for web search of external information (NEVER for analyzing private data or artifacts).",
                  ),
                configuration: z
                  .record(z.string(), z.unknown())
                  .optional()
                  .describe(
                    "ONLY user-specific values that must not be lost. Examples: {channel: '#sneaker-drops', email: 'alerts@company.com', targets: ['Nike.com', 'Adidas.com']}. DO NOT include URLs with paths, field names, intervals (already in signal), or implementation details.",
                  ),
              }),
            ),
          }),
        }),
        messages: [
          {
            role: "system",
            content: SYSTEM_PROMPT,
            providerOptions: getDefaultProviderOpts("anthropic"),
          },
          {
            role: "system",
            content: `## Capabilities

${getCapabilitiesSection()}

## User's Connected Services

${integrationsXml}`,
          },
          { role: "system", content: `Current date: ${getTodaysDate()}` },
          { role: "user", content: signalsAndAgentsPrompt },
        ],
        maxOutputTokens: 10_240,
        abortSignal,
      });

      logger.debug("AI SDK generateObject completed", {
        agent: "workspace-planner",
        step: "phase1-signals-agents",
        usage: phase1Result.usage,
      });

      const phase1 = phase1Result.object.plan;

      // Convert names to kebab-case IDs, dedup with numeric suffixes
      const signalsWithIds = phase1.signals.map((s, idx, arr) => {
        const baseId = toKebabCase(s.name);
        const duplicateCount = arr
          .slice(0, idx)
          .filter((other) => toKebabCase(other.name) === baseId).length;
        return { ...s, id: duplicateCount > 0 ? `${baseId}-${duplicateCount + 1}` : baseId };
      });
      const agentsWithIds = phase1.agents.map((a, idx, arr) => {
        const baseId = toKebabCase(a.name);
        const duplicateCount = arr
          .slice(0, idx)
          .filter((other) => toKebabCase(other.name) === baseId).length;
        return { ...a, id: duplicateCount > 0 ? `${baseId}-${duplicateCount + 1}` : baseId };
      });
      stream?.emit({
        type: "data-tool-progress",
        data: { toolName: "Workspace Planner", content: "Validating agent integrations" },
      });
      // Validate agent integrations (deterministic matching + unified credential validation)
      const clarifications: ClarificationItem[] = [];
      const credentialBindings: CredentialBinding[] = [];

      for (const agent of agentsWithIds) {
        // STEP 1: Try bundled agents (deterministic keyword matching)
        const bundledMatches = matchBundledAgents(agent.needs);
        if (bundledMatches.length === 1) {
          // Single bundled match - validate required fields
          const bundledMatch = bundledMatches.at(0);
          if (bundledMatch) {
            const validationResult = await validateRequiredFields(bundledMatch.requiredConfig);
            if (validationResult.missingCredentials.length > 0) {
              clarifications.push(
                createBundledMissingFieldsClarification(
                  agent.name,
                  agent.needs,
                  bundledMatch,
                  validationResult.missingCredentials,
                ),
              );
            }
            // Mark agent as using bundled (don't process MCP for this agent)
            continue;
          }
        } else if (bundledMatches.length > 1) {
          // Ambiguous bundled matches - user must choose
          clarifications.push(
            createAmbiguousBundledClarification(agent.name, agent.needs, bundledMatches),
          );
          continue;
        }
        // STEP 2: No bundled match - try MCP servers (deterministic keyword mapping)
        const mcpMatchesByNeed = new Map<string, MCPServerMatch[]>();
        for (const need of agent.needs) {
          const mcpMatches = mapNeedToMCPServers(need);
          mcpMatchesByNeed.set(need, mcpMatches);
          if (mcpMatches.length === 1) {
            // Single MCP match - validate required fields with configTemplate
            const mcpMatch = mcpMatches.at(0);
            if (mcpMatch) {
              const serverMeta = mcpServersRegistry.servers[mcpMatch.serverId];
              const validationResult = await validateRequiredFields(
                mcpMatch.requiredConfig,
                serverMeta?.configTemplate,
              );
              if (validationResult.missingCredentials.length > 0) {
                clarifications.push(
                  createMCPMissingFieldsClarification(
                    agent.name,
                    agent.needs,
                    mcpMatch,
                    validationResult.missingCredentials,
                  ),
                );
              }

              // Collect resolved credentials
              for (const resolved of validationResult.resolvedCredentials) {
                credentialBindings.push({
                  targetType: "mcp",
                  serverId: mcpMatch.serverId,
                  ...resolved,
                });
              }
            }
          } else if (mcpMatches.length > 1) {
            // Ambiguous MCP matches - user must choose
            clarifications.push(createAmbiguousMCPClarification(agent.name, need, mcpMatches));
          }
        }
        // STEP 3: Check for unmatched needs (no bundled or MCP found)
        const unmatchedNeeds = findUnmatchedNeeds(agent.needs, bundledMatches, mcpMatchesByNeed);
        for (const need of unmatchedNeeds) {
          clarifications.push(createNoMatchClarification(agent.name, need));
        }
      }

      // STEP 4: Validate atlas bundled agent credential requirements
      for (const agent of agentsWithIds) {
        // Try to match to a bundled agent by capabilities
        const bundledMatches = matchBundledAgents(agent.needs);
        if (bundledMatches.length !== 1) continue;

        const bundledMatch = bundledMatches[0];
        if (!bundledMatch) continue;

        const bundledAgent = bundledAgentsRegistry[bundledMatch.agentId];
        if (!bundledAgent) continue;

        for (const field of bundledAgent.requiredConfig) {
          // Skip non-Link fields (regular env vars validated elsewhere)
          if (field.from !== "link") continue;

          try {
            const creds = await resolveCredentialsByProvider(field.provider);
            if (creds.length > 0) {
              // biome-ignore lint/style/noNonNullAssertion: length check above guarantees [0] exists
              const firstCred = creds[0]!;
              credentialBindings.push({
                targetType: "agent",
                agentId: agent.id,
                field: field.envKey,
                credentialId: firstCred.id,
                provider: field.provider,
                key: field.key,
                label: firstCred.label || undefined,
              });
            }
          } catch (e) {
            if (e instanceof CredentialNotFoundError) {
              // Handle missing credential - add to missingCredentials
              logger.warn("Missing Link credential for agent", {
                agentId: agent.id,
                field: field.envKey,
                provider: field.provider,
              });
            }
          }
        }
      }

      // If any clarifications needed, return error and DON'T save artifact
      if (clarifications.length > 0) {
        const clarificationMessage = formatClarificationReport(clarifications);
        logger.warn("Workspace planning blocked by missing information", {
          clarificationCount: clarifications.length,
        });
        return fail({
          reason: `Cannot create workspace plan - missing required information:\n\n${clarificationMessage}`,
        });
      }
      const signalIds = signalsWithIds.map((s) => s.id);
      const agentIds = agentsWithIds.map((a) => a.id);
      stream?.emit({
        type: "data-tool-progress",
        data: { toolName: "Workspace Planner", content: "Planning jobs" },
      });
      // Generate jobs with enum-constrained signal/agent references
      const jobsPrompt = `You create job orchestrations by connecting signals to agent execution flows.

## Job Design Guidelines

- Jobs coordinate one or more agents through steps
- Same agent can appear multiple times in a job or across jobs
- Steps describe WHAT each step accomplishes in the workflow context
- Sequential: each step waits for previous to complete
- Parallel: all steps run simultaneously
- Prefer fewer jobs: one job per signal is often sufficient

## Output format

Generate jobs that connect the available signals and agents to fulfill the workspace requirements.`;

      const phase2Result = await generateObject({
        model: wrapAISDKModel(registry.languageModel("anthropic:claude-sonnet-4-5")),
        experimental_repairText: repairJson,
        schema: z.object({
          jobs: z.array(
            z.object({
              name: z
                .string()
                .describe(
                  "Human-readable job name. Example: 'Monitor and Notify' or 'Process GitHub Events'",
                ),
              title: z
                .string()
                .describe(
                  "Short 2-4 word title for UI. Examples: 'Daily Summary', 'Event Processor', 'Send Alerts'",
                ),
              triggerSignalId: z.enum(signalIds).describe("Signal ID that triggers this job"),
              steps: z
                .array(
                  z.object({
                    agentId: z.enum(agentIds).describe("Agent ID to execute"),
                    description: z.string().describe("What this step accomplishes"),
                  }),
                )
                .describe("Execution steps in order"),
              behavior: z.enum(["sequential", "parallel"]).describe("Execution pattern"),
            }),
          ),
        }),
        messages: [
          {
            role: "system",
            content: jobsPrompt,
            providerOptions: getDefaultProviderOpts("anthropic"),
          },
          {
            role: "user",
            content: `Create jobs connecting these components:

Signals:
${signalsWithIds.map((s) => `- ${s.id} (${s.name}): ${s.description}`).join("\n")}

Agents:
${agentsWithIds.map((a) => `- ${a.id} (${a.name}): ${a.description}`).join("\n")}

Requirements: ${input.intent}`,
          },
        ],
        maxOutputTokens: 10_240,
        abortSignal,
      });

      logger.debug("AI SDK generateObject completed", {
        agent: "workspace-planner",
        step: "phase2-jobs",
        usage: phase2Result.usage,
      });

      const phase2 = phase2Result.object;

      const jobsWithIds = phase2.jobs.map((j, idx, arr) => {
        const baseId = toKebabCase(j.name);
        const duplicateCount = arr
          .slice(0, idx)
          .filter((other) => toKebabCase(other.name) === baseId).length;
        return { ...j, id: duplicateCount > 0 ? `${baseId}-${duplicateCount + 1}` : baseId };
      });
      const planData: WorkspacePlan = {
        workspace: phase1.workspace,
        credentials: credentialBindings.length > 0 ? credentialBindings : undefined,
        signals: signalsWithIds,
        agents: agentsWithIds,
        jobs: jobsWithIds,
      };
      stream?.emit({
        type: "data-tool-progress",
        data: { toolName: "Workspace Planner", content: "Saving workspace plan artifact" },
      });
      if (existingPlan && input.artifactId) {
        const revisionMessage = await summarize({
          content: `Old plan:
            ${JSON.stringify(existingPlan)}
            New plan:
            ${JSON.stringify(planData)}`,
          instruction:
            "Summarize what changed between these two workspace plans in 1-2 sentences. Focus on what was added, removed, or modified.",
          logger,
          abortSignal,
        });
        const artifactSummary = await summarize({
          content: JSON.stringify(planData),
          instruction:
            "Summarize this workspace plan in 1-2 sentences. Describe what the workspace does and what agents/signals are involved.",
          logger,
          abortSignal,
        });
        const response = await parseResult(
          client.artifactsStorage[":id"].$put({
            param: { id: input.artifactId },
            json: {
              type: "workspace-plan",
              data: { type: "workspace-plan", version: 1, data: planData },
              summary: artifactSummary,
              revisionMessage,
            },
          }),
        );
        if (!response.ok) {
          throw new Error(`Failed to update artifact: ${JSON.stringify(response.error)}`);
        }
        return success({
          planSummary: planData.workspace.purpose,
          artifactId: response.data.artifact.id,
          revision: response.data.artifact.revision,
          nextStep:
            "Show plan to user. On approval, call fsm-workspace-creator with this artifactId. Do NOT call workspace-planner again.",
        });
      } else {
        const artifactSummary = await summarize({
          content: JSON.stringify(planData),
          instruction:
            "Summarize this workspace plan in 1-2 sentences. Describe what the workspace does and what agents/signals are involved.",
          logger,
          abortSignal,
        });
        const response = await parseResult(
          client.artifactsStorage.index.$post({
            json: {
              data: { type: "workspace-plan", version: 1, data: planData },
              title: planData.workspace.name,
              summary: artifactSummary,
              workspaceId: session.workspaceId,
              chatId: session.streamId,
            },
          }),
        );
        if (!response.ok) {
          throw new Error(`Failed to create artifact: ${JSON.stringify(response.error)}`);
        }
        return success({
          planSummary: planData.workspace.purpose,
          artifactId: response.data.artifact.id,
          revision: 1,
          nextStep:
            "Show plan to user. On approval, call fsm-workspace-creator with this artifactId. Do NOT call workspace-planner again.",
        });
      }
    } catch (error) {
      logger.error("Failed to plan workspace", { error });
      return fail({ reason: stringifyError(error) });
    }
  },

  environment: { required: [{ name: "ANTHROPIC_API_KEY", description: "Claude API key" }] },
});
