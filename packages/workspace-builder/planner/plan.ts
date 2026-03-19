import { repairJson } from "@atlas/agent-sdk";
import { bundledAgents } from "@atlas/bundled-agents";
import { JSONSchemaSchema } from "@atlas/core/artifacts";
import { mcpServersRegistry } from "@atlas/core/mcp-registry/registry-consolidated";
import type { MCPServerMetadata } from "@atlas/core/mcp-registry/schemas";
import { getMCPRegistryAdapter } from "@atlas/core/mcp-registry/storage";
import { getDefaultProviderOpts, registry, temporalGroundingMessage, traceModel } from "@atlas/llm";
import { createLogger } from "@atlas/logger";
import { generateObject } from "ai";
import { z } from "zod";
import { getCapabilitiesSection } from "../../system/agents/conversation/capabilities.ts";
import {
  fetchLinkSummary,
  formatIntegrationsSection,
} from "../../system/agents/conversation/link-context.ts";
import type { Agent, Signal } from "../types.ts";

const logger = createLogger({ component: "proto-planner" });

/**
 * Latin characters that NFKD normalization does not decompose.
 * Must be replaced before normalization or they get silently stripped.
 */
const LATIN_CHAR_MAP: Record<string, string> = {
  æ: "ae",
  Æ: "AE",
  œ: "oe",
  Œ: "OE",
  ß: "ss",
  ø: "o",
  Ø: "O",
  ł: "l",
  Ł: "L",
  đ: "d",
  Đ: "D",
  þ: "th",
  Þ: "TH",
  ð: "d",
  Ð: "D",
};

const LATIN_CHAR_RE = new RegExp(`[${Object.keys(LATIN_CHAR_MAP).join("")}]`, "g");

/** Strip zero-width chars, soft hyphens, BOM, and bidi controls. */
const INVISIBLE_RE = /[\u00AD\u200B-\u200F\u2028-\u202F\u2060-\u2069\uFEFF]/g;

/**
 * Convert a string to kebab-case. Mirrors `@std/text/to-kebab-case`
 * which isn't available outside workspace packages.
 */
export function toKebabCase(str: string): string {
  return str
    .replace(INVISIBLE_RE, "")
    .replace(LATIN_CHAR_RE, (ch) => LATIN_CHAR_MAP[ch] ?? ch)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
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

Split agents by external service boundary — one agent per service.

Each agent is an LLM with tool access. A single agent can call multiple tools within the same service (read, write, search, create) within its tool-calling budget. Do NOT split an agent just because it performs multiple operations on the same API.

Create SEPARATE agents when operations target DIFFERENT external services:
- Calendar and email = 2 agents (different APIs)
- GitHub and Slack = 2 agents (different APIs)
- Linear and Notion = 2 agents (different APIs)

Use ONE agent when operations target the SAME service:
- Search Slack + post to Slack = 1 Slack agent (same API)
- Read calendar + create meeting = 1 Calendar agent (same API)
- List Linear teams + list users + create issue = 1 Linear agent (same API)
- Parameterized targets for identical operations (monitoring multiple websites with same logic)

Do NOT create standalone summarizer, formatter, or data-transformation agents. Every agent can summarize and format as part of its work. If data flows from Service A to Service B, the Service B agent receives the data and handles any formatting itself.

Examples:
- Good: ONE "Calendar Manager" that reads today's events and creates tomorrow's meeting (same service)
- Good: ONE "Slack Incident Reporter" that searches messages and posts summary to #incidents (same service)
- Good: Separate "GitHub PR Fetcher" + "Slack Poster" (different services)
- Good: ONE "Website Monitor" with targets: ["Nike.com", "Adidas.com"] (same operation, different targets)
- Bad: Separate "Calendar Reader" + "Meeting Creator" (same service, unnecessarily split)
- Bad: "Slack Searcher" + "Summarizer" + "Slack Poster" (same service + needless summarizer)
- Bad: ONE "Research + Email Agent" (mixes different services)

### Agent capabilities

Select capability IDs from the Capabilities section below. Use an empty array when built-in capabilities are sufficient.

Each ID maps to a bundled agent or MCP server integration. Include ALL services the agent uses.

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

- One agent per external service — never split operations on the same API into separate agents
- No standalone summarizer or formatter agents — every agent handles its own output formatting
- Capture user-specific details in configuration (sparingly)
- Describe agents by WHAT they accomplish, not HOW (implementation)

## Writing guidelines

All user-facing copy should read like a product label — describe what the user gets, not how the system works.

- Never reference internal concepts: resource tables, agents, triggers, webhooks, CRUD, schemas, JSONB, pipelines
- Never use system narration: "Agents read and write...", "Triggers the X agent...", "Receives events from..."
- Agent descriptions: 1 short sentence — what it does for the user. Not how it works.
- Resource descriptions: minimal label — schema fields are shown separately
- Field descriptions: show enum options for enums, omit for self-evident fields (title, name, id, email, url)
- No qualifiers: "might", "should", "basically", "essentially"
- No enterprise speak: "robust", "comprehensive", "leverage", "facilitate"
- Precision > politeness

## Persistent state (resources)

Determine what persistent state this workspace needs to maintain across sessions.

Resources are persistent data that survives between runs. Declare a resource when
data must persist across separate executions — e.g., a grocery list, a contact
database, a log of processed items, a markdown report.

### Resource types

**Document** (type: "document") — structured data stored as JSONB array:
- Lists, trackers, inventories, logs, meeting notes, research briefs
- Schema: object with scalar properties (string, integer, number, boolean)
- Schema can include nested arrays/objects when domain is hierarchical (e.g., meetings with topics and action items)
- Use SQL identifier format for slugs: lowercase letters, digits, underscores

**Prose** (type: "prose") — markdown string content:
- Reports, summaries, briefs that agents revise across sessions
- No schema needed — content is a markdown string

**External-ref** (type: "external_ref") — data lives in an external service:
- Google Sheets, Notion, Airtable, GitHub, URL

### Schema guidance (document type)

- Use flat object with scalar properties (string, integer, number, boolean) for tabular data
- Use nested arrays/objects when domain is hierarchical (e.g., meetings with topics and action items)
- Use SQL identifier format for slugs: lowercase letters, digits, underscores (e.g., \`grocery_list\`, not \`grocery-list\`)

### When to declare resources

Declare a resource for EACH of these that applies:

**Document resource** — structured data stored in the platform:
- Workspace needs a list, log, or inventory that grows over time
- Multiple agents or jobs need to share state
- Data must persist between sessions (not just within a single job run)
- User says "store in Friday" or "track in the workspace" (NOT an external service)
- Data is naturally hierarchical (meeting notes with topics and action items) — use nested schema properties

**Prose resource** — markdown content stored in the platform:
- Agent-produced reports, summaries, briefs that are revised across sessions
- Content is a single markdown string, not structured data
- User says "keep notes", "maintain a report", "write a summary" without naming an external service — store as prose, not external-ref

**External-ref resource** (provider present, no schema) — data lives in an external service:
- User explicitly asks to store data in Notion, Google Sheets, Airtable, or another external service
- User provides a URL to an existing external resource (e.g., "my Notion page at https://notion.so/abc123")
- User says "create a new Notion database" or "put the data in a Google Sheet"

A single workspace can declare BOTH document resources AND external-ref resources.
Example: "Track my portfolio in Friday and sync a summary to Notion" = one document resource (portfolio) + one external-ref resource (Notion summary page).

### External ref: linking vs. creating

When declaring an external-ref resource:
- **Linking to existing resource:** Set the \`ref\` field to the URL or ID.
  Example: \`{provider: "notion", ref: "https://notion.so/abc123", description: "Meeting notes page. Syncs action items from calendar events."}\`
- **Creating a new resource:** Omit the \`ref\` field. The agent will create the
  resource on first run using the provider's MCP tools and register it via
  resource_link_ref.
  Example: \`{provider: "notion", description: "Reading notes database."}\`

If the user provides a URL or mentions an existing resource, set \`ref\`. If they
just say "store in Notion" without referencing something specific, omit \`ref\`.

### When NOT to declare resources

- Data flows from one agent to another within the same job (use document contracts)
- Agent writes to an external service as a one-shot notification (e.g., "send a Slack message") with no persistent state
- Data is ephemeral and only needed for a single run
- The external service IS the persistent store — when the user links to an existing Notion page or Google Sheet, that IS where data lives. Do NOT add a document resource for data that flows through the pipeline and ends up in the external service. Example: "read bank transactions and update my Google Sheet" needs only the Google Sheets external-ref, not an additional transactions document. The agent reads, processes, and writes to the sheet in one pass.

### Jobs and resource operations

Do NOT create jobs for basic resource operations (add, remove, update, query) that only touch workspace resources without external service integration. The workspace chat agent handles these directly via resource tools. Users interact with resources conversationally — no job needed.

Create jobs ONLY when the operation requires:
- **Scheduled triggers**: daily meal plan generation, weekly report compilation
- **External service integration**: import from Google Calendar, sync to Notion, fetch from API
- **Multi-step orchestration across services**: fetch data → transform → write to resource → notify via Slack
- **Hybrid operations**: resource CRUD combined with external service calls (e.g., add food and post summary to Slack)

A resource-only workspace (e.g., "track my food") should declare resources but generate zero jobs. The workspace IS the chat.`;

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
- agents: purpose, approach, capabilities, configuration
- resources: persistent state declarations (empty array if none needed)`;

const TASK_PROMPT_SECTION = `
## Context

You are planning a single task execution. The task will be triggered ad-hoc — no signals are needed.
Focus on selecting the right agents and their capabilities to accomplish the task.

## Output format

Generate structured plan with:
- workspace: name and purpose
- agents: purpose, approach, capabilities, configuration
- resources: persistent state declarations (empty array if none needed)`;

/**
 * Build the system prompt for the given planning mode.
 */
export function getSystemPrompt(mode: PlanMode): string {
  const modeSection = mode === "workspace" ? WORKSPACE_PROMPT_SECTION : TASK_PROMPT_SECTION;
  return `${SYSTEM_PROMPT_BASE}\n${modeSection}`;
}

/**
 * Format the user message sent to the model for plan generation.
 */
export function formatUserMessage(prompt: string, mode: PlanMode): string {
  return mode === "workspace"
    ? `Create a workspace plan for these requirements:\n${prompt}\nOne agent per external service. Do not split operations on the same API into separate agents.`
    : `Create a task plan for these requirements:\n${prompt}\nOne agent per external service. Do not split operations on the same API into separate agents. Do not generate signals — this task will be triggered ad-hoc.`;
}

// ---------------------------------------------------------------------------
// Phase 1 schema — mirrors workspace-planner generateObject schema
// ---------------------------------------------------------------------------

const WorkspaceSchema = z.object({
  name: z.string().describe("Workspace name (concise, human-readable)"),
  purpose: z
    .string()
    .describe(
      "What the user gets — 1-2 sentences, product-label voice. No implementation details (resource tables, HTTP triggers, webhooks, CRUD, on-demand). Example: 'Track tasks and store project docs in Notion.' Example: 'Weekly digest of merged PRs published to Notion.'",
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
      "Short badge for UI. Scheduled: 'Every Friday at 9am', 'Hourly'. External events: 'On GitHub push'. Prompt-driven (HTTP with no external integration): empty string — never 'Manual trigger' or 'Webhook'. Maximum 5 words.",
    ),
  payloadSchema: JSONSchemaSchema.optional().describe(
    "JSON Schema for signal payload. Define if signal needs user input or parameters. " +
      "Required: array of field names. Properties: field definitions. " +
      "Example: { type: 'object', required: ['user_input'], properties: { user_input: { type: 'string', description: 'User text input or description' } } }. " +
      "Use snake_case for field names. Omit for schedule-only triggers. " +
      "Signals are pure triggers — do NOT include artifact or file references in the payload schema. " +
      "Data discovery happens through the resource catalog, not signal payloads.",
  ),
});

const ResourceSchema = z.object({
  type: z
    .enum(["document", "prose", "artifact_ref", "external_ref"])
    .describe(
      "Resource type. 'document' for structured data (lists, trackers, inventories, hierarchical data). " +
        "'prose' for markdown string content (reports, summaries, briefs). " +
        "'artifact_ref' for read-only pointers to stored artifacts. " +
        "'external_ref' for pointers to external services (Google Sheets, Notion, etc.).",
    ),
  slug: z
    .string()
    .describe(
      "SQL identifier: lowercase letters, digits, underscores. Example: 'grocery_list', 'recipes'",
    ),
  name: z.string().describe("Human-readable resource name. Example: 'Grocery List'"),
  description: z
    .string()
    .describe(
      "Minimal label — schema fields are shown separately. Example: 'Project tasks.' Example: 'Weekly performance summary.' No system narration ('Agents read and write...').",
    ),
  schema: JSONSchemaSchema.optional().describe(
    "JSON Schema for document structure. Required for 'document' type. " +
      "Use flat object with scalar properties for tabular data. " +
      "Use nested arrays/objects when domain is hierarchical. " +
      "Example: { type: 'object', properties: { item: { type: 'string' }, quantity: { type: 'integer' } }, required: ['item'] }. " +
      "Omit for 'prose', 'artifact_ref', and 'external_ref'.",
  ),
  artifactId: z
    .string()
    .optional()
    .describe("Artifact UUID. Required for type 'artifact_ref'. Omit for other types."),
  provider: z
    .string()
    .optional()
    .describe(
      "External service provider. Required for type 'external_ref'. " +
        "Values: 'google-sheets', 'notion', 'airtable', 'github', 'url'. " +
        "Omit for other types.",
    ),
  ref: z
    .string()
    .optional()
    .describe(
      "URL or ID of an existing external resource to link to. " +
        "Set when the user provides a specific URL (e.g., 'https://notion.so/abc123'). " +
        "Omit when the agent should create a new resource on first run.",
    ),
});

// ---------------------------------------------------------------------------
// Dynamic capability IDs — built from bundled agents + MCP server registries
// ---------------------------------------------------------------------------

/**
 * Collect capability IDs from bundled agents, static MCP servers, and dynamic
 * MCP servers. Static IDs take precedence (deduped via Set).
 *
 * @returns Non-empty tuple suitable for `z.enum()` and dynamic server metadata for prompt rendering.
 */
export async function getCapabilityIds(): Promise<{
  ids: [string, ...string[]];
  dynamicServers: MCPServerMetadata[];
}> {
  const staticIds = [
    ...bundledAgents.map((a) => a.metadata.id),
    ...Object.keys(mcpServersRegistry.servers),
  ];

  let dynamicServers: MCPServerMetadata[] = [];
  try {
    const adapter = await getMCPRegistryAdapter();
    dynamicServers = await adapter.list();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("Failed to load dynamic MCP servers for capability IDs, using static only", {
      error: message,
    });
  }

  const dynamicIds = dynamicServers.map((s) => s.id);

  // Static first so Set dedup keeps static over dynamic
  const deduped = [...new Set([...staticIds, ...dynamicIds])];
  const [first, ...rest] = deduped;
  if (!first) {
    throw new Error("No capability IDs found — bundled agents and MCP registries are both empty");
  }
  return { ids: [first, ...rest], dynamicServers };
}

/**
 * Build the AgentSchema with capabilities constrained to known IDs.
 */
function buildAgentSchema(capabilityIds: [string, ...string[]]) {
  return z.object({
    name: z
      .string()
      .describe("Human-readable agent name. Example: 'Nike Website Monitor' or 'Discord Notifier'"),
    description: z
      .string()
      .describe(
        "What the agent does for the user — 1 short sentence. No verb lists (creates, updates, retrieves). No system mechanics (CRUD, resource tables, interprets the prompt). Good: 'Manages your tasks.' Good: 'Posts a price digest to Slack.' Bad: 'Creates, updates, and retrieves tasks in the workspace.'",
      ),
    capabilities: z
      .array(z.enum(capabilityIds))
      .describe(
        "IDs from the Capabilities section. Use empty array when built-in capabilities are sufficient.",
      ),
    configuration: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        "ONLY user-specific values that must not be lost. Examples: {channel: '#sneaker-drops', email: 'alerts@company.com', targets: ['Nike.com', 'Adidas.com']}. DO NOT include URLs with paths, field names, intervals (already in signal), or implementation details.",
      ),
  });
}

const resourcesField = z
  .array(ResourceSchema)
  .describe(
    "Persistent state this workspace needs across sessions. " +
      "Empty array if workspace has no mutable state needs.",
  );

/**
 * Build plan schemas using dynamic capability IDs.
 */
function buildPlanSchemas(capabilityIds: [string, ...string[]]) {
  const agentSchema = buildAgentSchema(capabilityIds);
  return {
    workspace: z.object({
      plan: z.object({
        workspace: WorkspaceSchema,
        signals: z.array(SignalSchema),
        agents: z.array(agentSchema),
        resources: resourcesField,
      }),
    }),
    task: z.object({
      plan: z.object({
        workspace: WorkspaceSchema,
        agents: z.array(agentSchema),
        resources: resourcesField,
      }),
    }),
  };
}

// ---------------------------------------------------------------------------
// Return type
// ---------------------------------------------------------------------------

/** Resource declaration from Phase 1 LLM output (pre-validation). */
export interface Phase1Resource {
  type: "document" | "prose" | "artifact_ref" | "external_ref";
  slug: string;
  name: string;
  description: string;
  schema?: Record<string, unknown>;
  artifactId?: string;
  provider?: string;
  ref?: string;
}

export interface Phase1Result {
  workspace: { name: string; purpose: string; details?: Array<{ label: string; value: string }> };
  signals: Signal[];
  agents: Agent[];
  resources: Phase1Resource[];
  /** Dynamic MCP servers fetched during planning — pass downstream to avoid redundant KV lookups. */
  dynamicServers: MCPServerMetadata[];
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
    if (!baseId) {
      throw new Error(`Name "${item.name}" produces an empty ID after sanitization`);
    }
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

  const [capabilityResult, linkSummary] = await Promise.all([
    getCapabilityIds(),
    fetchLinkSummary(logger),
  ]);

  const { ids: capabilityIds, dynamicServers } = capabilityResult;
  const schemas = buildPlanSchemas(capabilityIds);
  const integrationsXml = linkSummary
    ? formatIntegrationsSection(linkSummary, { includeLabels: false })
    : "<integrations><!-- No OAuth services connected --></integrations>";

  const userMessage = formatUserMessage(prompt, mode);

  if (mode === "task") {
    const result = await generateObject({
      model: traceModel(registry.languageModel("anthropic:claude-sonnet-4-6")),
      schema: schemas.task,
      experimental_repairText: repairJson,
      maxRetries: 3,
      messages: [
        {
          role: "system",
          content: getSystemPrompt(mode),
          providerOptions: getDefaultProviderOpts("anthropic"),
        },
        {
          role: "system",
          content: `## Capabilities\n\n${getCapabilitiesSection(dynamicServers)}\n\n## User's Connected Services\n\n${integrationsXml}`,
        },
        temporalGroundingMessage(),
        { role: "user", content: userMessage },
      ],
      maxOutputTokens: 10_240,
      abortSignal: options?.abortSignal,
    });

    const plan = result.object.plan;
    return {
      workspace: plan.workspace,
      signals: [],
      agents: assignKebabIds(plan.agents),
      resources: plan.resources,
      dynamicServers,
    };
  }

  const result = await generateObject({
    model: traceModel(registry.languageModel("anthropic:claude-sonnet-4-6")),
    schema: schemas.workspace,
    experimental_repairText: repairJson,
    maxRetries: 3,
    messages: [
      {
        role: "system",
        content: getSystemPrompt(mode),
        providerOptions: getDefaultProviderOpts("anthropic"),
      },
      {
        role: "system",
        content: `## Capabilities\n\n${getCapabilitiesSection(dynamicServers)}\n\n## User's Connected Services\n\n${integrationsXml}`,
      },
      temporalGroundingMessage(),
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
    resources: phase1.resources,
    dynamicServers,
  };
}
