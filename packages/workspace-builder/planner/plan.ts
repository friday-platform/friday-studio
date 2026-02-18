import { repairJson } from "@atlas/agent-sdk";
import { JSONSchemaSchema } from "@atlas/core/artifacts";
import { getDefaultProviderOpts, registry } from "@atlas/llm";
import { createLogger } from "@atlas/logger";
import { getTodaysDate } from "@atlas/utils";
import { generateObject } from "ai";
import { wrapAISDKModel } from "evalite/ai-sdk";
import { z } from "zod";
import { getCapabilitiesSection } from "../../system/agents/conversation/capabilities.ts";
import {
  fetchLinkSummary,
  formatIntegrationsSection,
} from "../../system/agents/conversation/link-context.ts";
import type { Agent, Signal } from "../types.ts";

const logger = createLogger({ component: "proto-planner" });

/**
 * Convert a string to kebab-case. Mirrors `@std/text/to-kebab-case`
 * which isn't available outside workspace packages.
 */
function toKebabCase(str: string): string {
  return str
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .toLowerCase();
}

// ---------------------------------------------------------------------------
// Planning mode
// ---------------------------------------------------------------------------

/** Planning mode: "workspace" includes signal planning, "task" excludes it. */
export type PlanMode = "workspace" | "task";

// ---------------------------------------------------------------------------
// System prompt — copied from workspace-planner.agent.ts (not importable)
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT_BASE = `
You create plans by analyzing user requirements and translating them into Atlas structure.

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

- Split agents by external system and capability boundary
- Capture user-specific details in configuration (sparingly)
- Describe agents by WHAT they accomplish, not HOW (implementation)

## Writing guidelines

Focus on user intent and deliver maximum clarity in minimum words.

- Use clear, succinct prose, avoiding technical jargon.
- Use imperatives: "Returns X" not "This function returns X"
- No qualifiers: "might", "should", "basically", "essentially"
- No enterprise speak: "robust", "comprehensive", "leverage", "facilitate"
- Precision > politeness`;

const WORKSPACE_PROMPT_SECTION = `
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

## Output format

Generate structured plan with:
- workspace: name and purpose
- signals: trigger descriptions with rationale
- agents: purpose, approach, needs, configuration`;

const TASK_PROMPT_SECTION = `
## Context

You are planning a single task execution. The task will be triggered ad-hoc — no signals are needed.
Focus on selecting the right agents and their capabilities to accomplish the task.

## Output format

Generate structured plan with:
- workspace: name and purpose
- agents: purpose, approach, needs, configuration`;

/**
 * Build the system prompt for the given planning mode.
 */
function getSystemPrompt(mode: PlanMode): string {
  const modeSection = mode === "workspace" ? WORKSPACE_PROMPT_SECTION : TASK_PROMPT_SECTION;
  return `${SYSTEM_PROMPT_BASE}\n${modeSection}`;
}

// ---------------------------------------------------------------------------
// Phase 1 schema — mirrors workspace-planner generateObject schema
// ---------------------------------------------------------------------------

const WorkspaceSchema = z.object({
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
    .optional()
    .describe(
      "User-provided details extracted from requirements. ONLY include human-readable values like repository names (org/repo), channel names (#channel), database/page names, email addresses. NEVER include: IDs, UUIDs, technical identifiers, timezones (shown in schedule), or credential info (shown in integrations). Omit if no specific values were provided.",
    ),
});

const SignalSchema = z.object({
  name: z
    .string()
    .describe("Human-readable signal name. Example: 'Check Schedule' or 'GitHub Push Event'"),
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
});

const AgentSchema = z.object({
  name: z
    .string()
    .describe("Human-readable agent name. Example: 'Nike Website Monitor' or 'Discord Notifier'"),
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
});

/** Workspace mode: includes signals array in the schema. */
const WorkspacePlanSchema = z.object({
  plan: z.object({
    workspace: WorkspaceSchema,
    signals: z.array(SignalSchema),
    agents: z.array(AgentSchema),
  }),
});

/** Task mode: no signals — agents only. */
const TaskPlanSchema = z.object({
  plan: z.object({ workspace: WorkspaceSchema, agents: z.array(AgentSchema) }),
});

// ---------------------------------------------------------------------------
// Return type
// ---------------------------------------------------------------------------

export interface Phase1Result {
  workspace: { name: string; purpose: string; details?: Array<{ label: string; value: string }> };
  signals: Signal[];
  agents: Agent[];
}

// ---------------------------------------------------------------------------
// Kebab-case ID generation with dedup suffixes
// ---------------------------------------------------------------------------

/**
 * Assign kebab-case IDs to an array of named items, appending numeric
 * suffixes when multiple items share the same base ID.
 */
function assignKebabIds<T extends { name: string }>(items: T[]): Array<T & { id: string }> {
  return items.map((item, idx, arr) => {
    const baseId = toKebabCase(item.name);
    const duplicateCount = arr
      .slice(0, idx)
      .filter((other) => toKebabCase(other.name) === baseId).length;
    return { ...item, id: duplicateCount > 0 ? `${baseId}-${duplicateCount + 1}` : baseId };
  });
}

// ---------------------------------------------------------------------------
// Phase 1: generate signals + agents from a user prompt
// ---------------------------------------------------------------------------

/**
 * Generate a workspace plan (signals + agents) from a user prompt.
 * Standalone extraction of workspace-planner's Phase 1 logic.
 *
 * @param prompt - User requirements
 * @param options - Planning options
 * @param options.mode - "workspace" includes signal planning (default), "task" excludes it
 * @param options.abortSignal - Abort signal for cancellation
 */
export async function generatePlan(
  prompt: string,
  options?: { mode?: PlanMode; abortSignal?: AbortSignal },
): Promise<Phase1Result> {
  const mode = options?.mode ?? "workspace";

  const linkSummary = await fetchLinkSummary(logger);
  const integrationsXml = linkSummary
    ? formatIntegrationsSection(linkSummary)
    : "<integrations><!-- No OAuth services connected --></integrations>";

  const userMessage =
    mode === "workspace"
      ? `Create a workspace plan for these requirements:\n${prompt}\nSplit agents by external system and capability boundary. Each agent should handle one integration point or one distinct capability.`
      : `Create a task plan for these requirements:\n${prompt}\nSplit agents by external system and capability boundary. Each agent should handle one integration point or one distinct capability. Do not generate signals — this task will be triggered ad-hoc.`;

  if (mode === "task") {
    const result = await generateObject({
      model: wrapAISDKModel(registry.languageModel("anthropic:claude-sonnet-4-6")),
      schema: TaskPlanSchema,
      experimental_repairText: repairJson,
      messages: [
        {
          role: "system",
          content: getSystemPrompt(mode),
          providerOptions: getDefaultProviderOpts("anthropic"),
        },
        {
          role: "system",
          content: `## Capabilities\n\n${getCapabilitiesSection()}\n\n## User's Connected Services\n\n${integrationsXml}`,
        },
        { role: "system", content: `Current date: ${getTodaysDate()}` },
        { role: "user", content: userMessage },
      ],
      maxOutputTokens: 10_240,
      abortSignal: options?.abortSignal,
    });

    const plan = result.object.plan;
    return { workspace: plan.workspace, signals: [], agents: assignKebabIds(plan.agents) };
  }

  const result = await generateObject({
    model: wrapAISDKModel(registry.languageModel("anthropic:claude-sonnet-4-6")),
    schema: WorkspacePlanSchema,
    experimental_repairText: repairJson,
    messages: [
      {
        role: "system",
        content: getSystemPrompt(mode),
        providerOptions: getDefaultProviderOpts("anthropic"),
      },
      {
        role: "system",
        content: `## Capabilities\n\n${getCapabilitiesSection()}\n\n## User's Connected Services\n\n${integrationsXml}`,
      },
      { role: "system", content: `Current date: ${getTodaysDate()}` },
      { role: "user", content: userMessage },
    ],
    maxOutputTokens: 10_240,
    abortSignal: options?.abortSignal,
  });

  const phase1 = result.object.plan;
  return {
    workspace: phase1.workspace,
    signals: assignKebabIds(phase1.signals),
    agents: assignKebabIds(phase1.agents),
  };
}
