import { z } from "zod";

/**
 * Configuration field descriptor for bundled agents
 * Describes what users must provide for this agent to work
 */
const BundledAgentConfigFieldSchema = z.object({
  key: z.string().min(1),
  description: z.string().min(1),
  type: z.enum(["string", "array", "object", "number", "boolean"]),
  validation: z.string().optional(),
  default: z.string().optional(),
  examples: z.array(z.string()).optional(),
});

export type BundledAgentConfigField = z.infer<typeof BundledAgentConfigFieldSchema>;

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
  requiredConfig: BundledAgentConfigField[];
  optionalConfig?: BundledAgentConfigField[];

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
        key: "SLACK_MCP_XOXP_TOKEN",
        description: "Slack user token used by slack-mcp-server to access Slack APIs",
        type: "string",
        validation: "^(xoxb|xoxc|xoxp|xoxd)-",
        examples: ["xoxp-123456789-123456789-123456789-abc123"],
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
      "Compose and send email notifications via SendGrid. Generates email content from provided data/context, with template support, file attachments, and automatic retry with exponential backoff",
    capabilities: ["email", "notifications", "sendgrid", "messaging"],
    examples: [
      "Send email to john@example.com with subject 'Test' saying hello",
      "Email sarah@company.com a meeting reminder for 2pm today",
      "Send deployment completion notification to team@startup.io",
      "Create professional pricing report email from this data and send to client@company.com",
    ],
    requiredConfig: [
      {
        key: "SENDGRID_API_KEY",
        description: "SendGrid API key for sending emails",
        type: "string",
        validation: "^SG\\.",
        examples: ["SG.abc123xyz..."],
      },
    ],
    optionalConfig: [
      {
        key: "SENDGRID_FROM_EMAIL",
        description: "Default sender email address",
        type: "string",
        default: "noreply@tempestdx.com",
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
        key: "GOOGLE_OAUTH_CREDENTIALS",
        description:
          "Google OAuth credentials JSON for Google Calendar API access via Google Calendar MCP Server",
        type: "string",
        examples: ['{"client_id":"...","client_secret":"...","refresh_token":"..."}'],
      },
    ],
    packagePath: "@atlas/bundled-agents/google",
    requiresMCP: ["google-calendar-mcp"],
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
    capabilities: ["research", "web-search", "analysis", "reporting"],
    examples: [
      "Research Parker Conrad and provide a comprehensive report",
      "Find information about quantum computing trends",
      "Research market analysis for AI startups",
    ],
    requiredConfig: [
      {
        key: "TAVILY_API_KEY",
        description: "Tavily API key for web search capabilities",
        type: "string",
        examples: ["tvly-abc123..."],
      },
    ],
    packagePath: "@atlas/bundled-agents/research",
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
    requiredConfig: [
      {
        key: "FATHOM_API_KEY",
        description: "Fathom AI API key for authentication",
        type: "string",
        examples: ["fathom_abc123..."],
      },
    ],
    packagePath: "@atlas/bundled-agents/fathom",
  },
};
