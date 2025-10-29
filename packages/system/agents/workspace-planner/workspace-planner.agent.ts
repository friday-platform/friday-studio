import { createAgent } from "@atlas/agent-sdk";
import { client, parseResult } from "@atlas/client/v2";
import { anthropic } from "@atlas/core";
import type { WorkspacePlan } from "@atlas/core/artifacts";
import { fail, getTodaysDate, type Result, stringifyError, success } from "@atlas/utils";
import { toKebabCase } from "@std/text";
import { generateObject, generateText } from "ai";
import { z } from "zod";

type WorkspacePlannerResult = Result<
  { planSummary: string; artifactId: string; revision: number },
  { reason: string }
>;

const WorkspacePlannerInputSchema = z.object({
  intent: z.string().describe("Workspace requirements or modification request"),
  artifactId: z.string().optional().describe("Artifact ID to update (omit for new plans)"),
});

type WorkspacePlannerInput = z.infer<typeof WorkspacePlannerInputSchema>;

/**
 * Generates concise summaries via Haiku 3.5 for revision messages and plan summaries.
 */
async function summarize(params: {
  content: string;
  instruction: string;
  abortSignal?: AbortSignal;
}): Promise<string> {
  const { text } = await generateText({
    model: anthropic("claude-haiku-4-5"),
    system:
      "You generate concise, accurate summaries. No fluff, no marketing speak. Direct and informative.",
    prompt: `
    ${params.instruction}

    Content:
    ${params.content}`,
    maxOutputTokens: 100,
    abortSignal: params.abortSignal,
  });

  return text.trim();
}

const SYSTEM_PROMPT = `
You create workspace plans by analyzing user requirements and translating them into Atlas structure.

## Context

Atlas workspaces automate tasks using:
- Signals: Triggers (webhooks, schedules, file watchers)
- Agents: AI executors that process data and perform actions
- Jobs: Orchestration connecting signals to agents

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
- Precision > politeness

Current date: ${getTodaysDate()}`;

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

      stream?.emit({
        type: "data-tool-progress",
        data: { toolName: "Workspace Planner", content: "Analyzing requirements..." },
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
      const { object: phase1Response } = await generateObject({
        model: anthropic("claude-sonnet-4-5-20250929"),
        schema: z.object({
          plan: z.object({
            workspace: z.object({
              name: z.string().describe("Workspace name (concise, human-readable)"),
              purpose: z
                .string()
                .describe(
                  "What this workspace accomplishes and why it matters. 3-5 sentences that explain the automation's value to the user.",
                ),
            }),
            signals: z.array(
              z.object({
                name: z
                  .string()
                  .describe(
                    "Human-readable signal name. Example: 'Check Schedule' or 'GitHub Push Event'",
                  ),
                description: z
                  .string()
                  .describe(
                    "When and how this triggers, including rationale. 1-2 sentences. Examples: 'Runs every 30 minutes during business hours to catch new products quickly without overwhelming the website' or 'Webhook endpoint receives GitHub push events to trigger immediate CI builds'",
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
                    "High-level capabilities this agent requires. Use generic categories ('web-access', 'notifications', 'data-storage', 'email') unless referring to specific brands/services ('google-calendar', 'slack', 'discord', 'github').",
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
        system: SYSTEM_PROMPT,
        prompt: signalsAndAgentsPrompt,
        maxOutputTokens: 10_240,
        abortSignal,
      });

      const phase1 = phase1Response.plan;

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

      const signalIds = signalsWithIds.map((s) => s.id);
      const agentIds = agentsWithIds.map((a) => a.id);

      stream?.emit({
        type: "data-tool-progress",
        data: { toolName: "Workspace Planner", content: "Planning jobs..." },
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

      const { object: phase2Response } = await generateObject({
        model: anthropic("claude-sonnet-4-5-20250929"),
        schema: z.object({
          jobs: z.array(
            z.object({
              name: z
                .string()
                .describe(
                  "Human-readable job name. Example: 'Monitor and Notify' or 'Process GitHub Events'",
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
        system: jobsPrompt,
        prompt: `Create jobs connecting these components:

Signals:
${signalsWithIds.map((s) => `- ${s.id} (${s.name}): ${s.description}`).join("\n")}

Agents:
${agentsWithIds.map((a) => `- ${a.id} (${a.name}): ${a.description}`).join("\n")}

Requirements: ${input.intent}`,
        maxOutputTokens: 10_240,
        abortSignal,
      });

      const phase2 = phase2Response;

      const jobsWithIds = phase2.jobs.map((j, idx, arr) => {
        const baseId = toKebabCase(j.name);
        const duplicateCount = arr
          .slice(0, idx)
          .filter((other) => toKebabCase(other.name) === baseId).length;
        return { ...j, id: duplicateCount > 0 ? `${baseId}-${duplicateCount + 1}` : baseId };
      });

      const planData: WorkspacePlan = {
        workspace: phase1.workspace,
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
          abortSignal,
        });

        const artifactSummary = await summarize({
          content: JSON.stringify(planData),
          instruction:
            "Summarize this workspace plan in 1-2 sentences. Describe what the workspace does and what agents/signals are involved.",
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
        });
      } else {
        const artifactSummary = await summarize({
          content: JSON.stringify(planData),
          instruction:
            "Summarize this workspace plan in 1-2 sentences. Describe what the workspace does and what agents/signals are involved.",
          abortSignal,
        });

        const response = await parseResult(
          client.artifactsStorage.index.$post({
            json: {
              type: "workspace-plan",
              data: { type: "workspace-plan", version: 1, data: planData },
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
        });
      }
    } catch (error) {
      logger.error("Failed to plan workspace", { error });
      return fail({ reason: stringifyError(error) });
    }
  },

  environment: { required: [{ name: "ANTHROPIC_API_KEY", description: "Claude API key" }] },
});
