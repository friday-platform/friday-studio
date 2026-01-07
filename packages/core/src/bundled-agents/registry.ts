import { z } from "zod";

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
};

/**
 * Registry of bundled agents compiled into Atlas
 * These agents are available to all workspaces by default
 */
export const bundledAgentsRegistry: Record<string, BundledAgentRegistryItem> = {
  slack: {
    id: "slack",
    name: "Slack",
    version: "1.0.0",
    description:
      "Post messages to Slack channels and DMs; search message history across channels, threads, and conversations; manage channels and users via slack-mcp-server",
    capabilities: ["slack", "messaging", "notifications", "communication"],
    examples: [
      "Post update to #general: Shipping v1.2 today",
      "Send this artifact to #product: {{artifact_id}}",
    ],
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
  },

  email: {
    id: "email",
    name: "Email",
    version: "1.0.0",
    description:
      "Compose and send email notifications via SendGrid through Atlas gateway. Generates email content from provided data/context, with template support, file attachments, and automatic retry with exponential backoff",
    capabilities: ["email", "gmail", "notifications", "sendgrid", "messaging"],
    examples: [
      "Send email to john@example.com with subject 'Test' saying hello",
      "Email sarah@company.com a meeting reminder for 2pm today",
      "Send deployment completion notification to team@startup.io",
      "Create professional pricing report email from this data and send to client@company.com",
    ],
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
        default: "noreply@hellofriday.ai",
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
  },

  "google-calendar": {
    id: "google-calendar",
    name: "Google Calendar",
    version: "1.0.0",
    description: "Search Google Calendar events via google-calendar-mcp",
    capabilities: ["google-calendar", "google", "calendar", "scheduling", "meetings"],
    examples: [
      "Please provide availability looking at both my personal and work calendar for this upcoming week",
      "Which events tomorrow have attendees who have not accepted the invitation?",
      "Get all of my events for today",
      "Get all of my events for next week",
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
  },

  "get-summary": {
    id: "get-summary",
    name: "Summarizer",
    version: "1.0.0",
    description: "Create a summary of the provided content",
    capabilities: ["summaries", "summarization", "content-analysis"],
    examples: ["Create a summary of the provided content", "Summarize this content"],
    requiredConfig: [],
    packagePath: "@atlas/bundled-agents/summary",
  },

  research: {
    id: "research",
    name: "Research",
    version: "1.0.0",
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
  },

  "claude-code": {
    id: "claude-code",
    name: "Claude Code",
    version: "1.0.0",
    description: "Execute coding tasks using Claude API with sandboxed filesystem access",
    capabilities: ["code-generation", "coding", "file-operations", "development", "programming"],
    examples: [
      "Write a TypeScript function to parse JSON",
      "Read and analyze the package.json file",
      "Generate a React component",
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
  },

  "fathom-get-transcript": {
    id: "fathom-get-transcript",
    name: "Fathom Get Transcript",
    version: "1.0.0",
    description: "Get the latest meeting from Fathom AI and retrieve its transcript",
    capabilities: ["fathom", "meetings", "transcripts", "recording"],
    examples: [
      "Get the transcript of my latest Fathom meeting",
      "Show me the most recent meeting transcript",
      "What was discussed in my last meeting?",
    ],
    requiredConfig: [{ key: "FATHOM_API_KEY", description: "Fathom API key", type: "string" }],
    packagePath: "@atlas/bundled-agents/fathom",
  },
};
