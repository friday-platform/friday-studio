import type { AtlasAgent } from "@atlas/agent-sdk";
import { z } from "zod";
import { ClaudeCodeOutputSchema, claudeCodeAgent } from "./claude-code/agent.ts";
import { DataAnalystOutputSchema, dataAnalystAgent } from "./data-analyst/agent.ts";
import { EmailOutputSchema, emailAgent } from "./email/communicator.ts";
import { FathomOutputSchema, fathomGetTranscriptAgent } from "./fathom-ai/get-transcript.ts";
import { GoogleCalendarOutputSchema, googleCalendarAgent } from "./google/calendar.ts";
import { SlackOutputSchema, slackCommunicatorAgent } from "./slack/communicator.ts";
import { SummaryOutputSchema, summaryAgent } from "./summary.ts";
import { TableOutputSchema, tableAgent } from "./table.ts";
import { ResearchOutputSchema, webSearchAgent } from "./web-search/web-search.ts";

/**
 * Configuration field descriptor for bundled agents
 * Describes what users must provide for this agent to work
 */

/**
 * Environment variable configuration field (input type)
 * For plain environment variables (not resolved from Link)
 */
const EnvConfigFieldInputSchema = z.object({
  from: z.literal("env").optional(),
  key: z.string().min(1).describe("Env var name"),
  description: z.string().min(1),
  type: z.enum(["string", "array", "object", "number", "boolean"]),
  validation: z.string().optional(),
  default: z.string().optional(),
  examples: z.array(z.string()).optional(),
});

/**
 * Environment variable configuration field (output type)
 */
const EnvConfigFieldSchema = EnvConfigFieldInputSchema.transform((val) => ({
  ...val,
  from: "env" as const,
}));

/**
 * Link credential reference configuration field
 * Aligns with LinkCredentialRefSchema from @atlas/agent-sdk:
 * - `from: "link"` discriminator
 * - `provider` for provider-based resolution
 * - `key` for the secret key within credential.secret
 * - `envKey` for the env var name to expose (bundled-agent specific)
 */
const LinkConfigFieldSchema = z.object({
  from: z.literal("link"),
  envKey: z.string().min(1).describe("Env var name to expose (e.g., SLACK_MCP_XOXP_TOKEN)"),
  provider: z.string().describe("Link provider (e.g., slack)"),
  key: z.string().describe("Key in credential.secret (e.g., access_token)"),
  description: z.string().min(1),
});

const BundledAgentConfigFieldSchema = z.union([EnvConfigFieldSchema, LinkConfigFieldSchema]);

export type BundledAgentConfigField = z.infer<typeof BundledAgentConfigFieldSchema>;

/**
 * Input type for bundled agent config field (what developers write in the registry)
 */
export type BundledAgentConfigFieldInput = z.input<typeof BundledAgentConfigFieldSchema>;

/**
 * Bundled agent registry item
 * Metadata about agents that are compiled into Atlas
 */
export type BundledAgentRegistryItem = {
  // Identity
  id: string;
  name: string;
  description: string;
  version: string;

  // Classification
  capabilities: string[]; // What needs this agent can satisfy
  examples: string[];

  // Configuration
  requiredConfig: BundledAgentConfigFieldInput[];
  optionalConfig?: BundledAgentConfigFieldInput[];

  // Integration
  packagePath: string; // e.g., "@atlas/bundled-agents/slack"
  requiresMCP?: string[]; // MCP server IDs this agent needs

  // Output contract
  outputSchema?: z.core.JSONSchema.BaseSchema; // JSONSchema describing result.output shape
};

/**
 * Build a registry entry from an agent instance + output schema + overrides.
 * Derives id, name, version, description, capabilities, and examples
 * from the agent metadata. Overrides take precedence.
 */
function fromAgent(
  agent: AtlasAgent,
  outputSchema: z.ZodType,
  overrides: Omit<
    BundledAgentRegistryItem,
    "id" | "name" | "version" | "description" | "capabilities" | "examples" | "outputSchema"
  > &
    Partial<Pick<BundledAgentRegistryItem, "name" | "description" | "capabilities" | "examples">>,
): BundledAgentRegistryItem {
  const { metadata } = agent;

  return {
    id: metadata.id,
    name: overrides.name ?? metadata.displayName ?? metadata.id,
    version: metadata.version,
    description: overrides.description ?? metadata.description,
    capabilities: overrides.capabilities ?? metadata.expertise.domains,
    examples: overrides.examples ?? metadata.expertise.examples,
    outputSchema: z.toJSONSchema(outputSchema),
    requiresMCP: overrides.requiresMCP,
    requiredConfig: overrides.requiredConfig,
    optionalConfig: overrides.optionalConfig,
    packagePath: overrides.packagePath,
  };
}

/**
 * Registry of bundled agents compiled into Atlas
 * These agents are available to all workspaces by default
 *
 * Agent metadata (id, name, version, description, capabilities, examples, requiresMCP)
 * is derived from the agent instances. Only config and overrides are specified here.
 */
export const bundledAgentsRegistry: Record<string, BundledAgentRegistryItem> = {
  slack: fromAgent(slackCommunicatorAgent, SlackOutputSchema, {
    capabilities: ["slack", "messaging", "notifications", "communication"],
    requiredConfig: [
      {
        from: "link",
        envKey: "SLACK_MCP_XOXP_TOKEN",
        provider: "slack",
        key: "access_token",
        description: "Slack user token from Link",
      },
    ],
    packagePath: "@atlas/bundled-agents/slack",
    requiresMCP: ["slack-mcp-server"],
  }),

  email: fromAgent(emailAgent, EmailOutputSchema, {
    capabilities: ["email", "gmail", "notifications", "sendgrid", "messaging"],
    requiredConfig: [
      {
        key: "FRIDAY_GATEWAY_URL",
        description: "Gateway URL (e.g., https://gateway.friday.ai)",
        type: "string",
        examples: ["https://gateway.friday.ai", "http://localhost:8080"],
      },
    ],
    optionalConfig: [
      {
        key: "SENDGRID_FROM_EMAIL",
        description: "Default sender email address",
        type: "string",
        default: "notifications@hellofriday.ai",
        examples: ["noreply@company.com", "team@startup.io"],
      },
      {
        key: "SENDGRID_FROM_NAME",
        description: "Default sender name",
        type: "string",
        examples: ["Company Team", "Notification System"],
      },
      {
        key: "SENDGRID_SANDBOX_MODE",
        description: "Enable sandbox mode for testing (true/false)",
        type: "boolean",
        default: "false",
        examples: ["true", "false"],
      },
    ],
    packagePath: "@atlas/bundled-agents/email",
  }),

  "google-calendar": fromAgent(googleCalendarAgent, GoogleCalendarOutputSchema, {
    capabilities: [
      "google-calendar",
      "calendar",
      "scheduling",
      "meetings",
      "events",
      "availability",
    ],
    requiredConfig: [
      {
        from: "link",
        envKey: "GOOGLE_CALENDAR_ACCESS_TOKEN",
        provider: "google-calendar",
        key: "access_token",
        description: "Google Calendar OAuth token from Link",
      },
    ],
    packagePath: "@atlas/bundled-agents/google",
    requiresMCP: ["google-calendar"],
  }),

  "get-summary": fromAgent(summaryAgent, SummaryOutputSchema, {
    name: "Summarizer",
    capabilities: ["summaries", "summarization", "content-analysis"],
    requiredConfig: [],
    packagePath: "@atlas/bundled-agents/summary",
  }),

  research: fromAgent(webSearchAgent, ResearchOutputSchema, {
    description:
      "Multi-agent research system with parallel sub-agents for comprehensive web research and report generation",
    capabilities: ["research", "web-search", "web-research", "web"],
    examples: [
      "Research Parker Conrad and provide a comprehensive report",
      "Find information about quantum computing trends",
      "Research market analysis for AI startups",
    ],
    requiredConfig: [],
    optionalConfig: [
      {
        key: "FRIDAY_GATEWAY_URL",
        description: "Gateway URL. When set, routes Parallel API calls through the gateway.",
        type: "string",
        examples: ["https://gateway.friday.ai"],
      },
      {
        key: "PARALLEL_API_KEY",
        description: "Parallel API key for direct access (alternative to gateway).",
        type: "string",
      },
    ],
    packagePath: "@atlas/bundled-agents/research",
  }),

  "claude-code": fromAgent(claudeCodeAgent, ClaudeCodeOutputSchema, {
    capabilities: [
      "code-generation",
      "coding",
      "file-operations",
      "development",
      "programming",
      "code-analysis",
      "debugging",
      "root-cause-analysis",
    ],
    requiredConfig: [
      {
        from: "link",
        envKey: "ANTHROPIC_API_KEY",
        provider: "anthropic",
        key: "api_key",
        description: "Anthropic API key from Link for Claude API access",
      },
    ],
    packagePath: "@atlas/bundled-agents/claude-code",
  }),

  "fathom-get-transcript": fromAgent(fathomGetTranscriptAgent, FathomOutputSchema, {
    requiredConfig: [{ key: "FATHOM_API_KEY", description: "Fathom API key", type: "string" }],
    packagePath: "@atlas/bundled-agents/fathom",
  }),

  "data-analyst": fromAgent(dataAnalystAgent, DataAnalystOutputSchema, {
    capabilities: ["data-analysis", "sql", "reporting", "database", "analytics", "csv-analysis"],
    requiredConfig: [],
    packagePath: "@atlas/bundled-agents/data-analyst",
  }),

  table: fromAgent(tableAgent, TableOutputSchema, {
    capabilities: ["table-generation", "tables", "visualization"],
    requiredConfig: [],
    packagePath: "@atlas/bundled-agents/table",
  }),
};
