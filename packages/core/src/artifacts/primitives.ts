import { NamespaceSchema, SkillNameSchema } from "@atlas/config";
import { z } from "zod";

/**
 * Credential binding resolved during workspace planning.
 * Each binding maps one MCP server or agent field to one resolved credential.
 * Created by workspace-planner, applied by fsm-workspace-creator.
 *
 * Note: `@atlas/schemas/workspace` defines a flat variant with generic `targetId`.
 * Both schemas represent the same concept — planner uses `serverId`/`agentId` fields,
 * workspace configs use `targetId`.
 */
const MCPCredentialBindingSchema = z.object({
  targetType: z.literal("mcp"),
  serverId: z.string().describe("MCP server ID (e.g., slack-mcp-server)"),
  field: z.string().describe("Env var name (e.g., SLACK_BOT_TOKEN)"),
  credentialId: z.string().describe("Resolved Link credential ID"),
  provider: z.string().describe("Provider for debugging"),
  key: z.string().describe("Secret key (e.g., access_token)"),
  label: z.string().optional().describe("Account display name for UI (e.g., 'tempestteam')"),
});

const AgentCredentialBindingSchema = z.object({
  targetType: z.literal("agent"),
  agentId: z.string().describe("Agent ID from workspace plan"),
  field: z.string().describe("Env var name (e.g., SLACK_BOT_TOKEN)"),
  credentialId: z.string().describe("Resolved Link credential ID"),
  provider: z.string().describe("Provider for debugging"),
  key: z.string().describe("Secret key (e.g., access_token)"),
  label: z.string().optional().describe("Account display name for UI (e.g., 'tempestteam')"),
});

export const CredentialBindingSchema = z.discriminatedUnion("targetType", [
  MCPCredentialBindingSchema,
  AgentCredentialBindingSchema,
]);
export type CredentialBinding = z.infer<typeof CredentialBindingSchema>;

/**
 * Signal types for workspace plans.
 * - schedule: Cron-based time triggers (e.g., "every Friday at 9am")
 * - http: Webhook/API endpoints (e.g., "GitHub push webhook")
 * - fs-watch: Filesystem change triggers (e.g., "watches notes directory")
 */
const SignalTypeSchema = z.enum(["schedule", "http", "fs-watch"]);

/** User-provided detail for UI display */
const DetailSchema = z.object({
  label: z.string().describe("Human-readable label (e.g., 'GitHub Repository', 'Slack Channel')"),
  value: z.string().describe("User-provided value (e.g., 'org/repo', '#releases')"),
});

export const WorkspacePlanSchema = z.object({
  workspace: z.object({
    name: z.string().describe("Workspace name (concise, human-readable)"),
    purpose: z
      .string()
      .describe(
        "What this workspace does and how it works. 1-3 sentences. Focus on the task mechanics, not the value proposition.",
      ),
    details: z
      .array(DetailSchema)
      .optional()
      .describe("User-provided details for UI display (e.g., repositories, channels, databases)"),
  }),

  credentials: z
    .array(CredentialBindingSchema)
    .optional()
    .describe("Resolved credential bindings - applied declaratively during workspace creation"),

  signals: z.array(
    z.object({
      id: z.string().describe("Kebab-case identifier. Example: 'new-note-detected'"),
      name: z
        .string()
        .describe("Human-readable signal name. Example: 'Check Schedule' or 'GitHub Push Event'"),
      title: z
        .string()
        .describe(
          "Short verb-noun sentence for UI display. Examples: 'Triggers daily at 10am PST', 'Receives GitHub push events', 'Watches for new files'",
        ),
      signalType: SignalTypeSchema.describe(
        "Signal provider type. 'schedule' for cron-based triggers, 'http' for webhooks/API endpoints, 'fs-watch' for filesystem changes.",
      ),
      description: z
        .string()
        .describe(
          "When and how this triggers, including rationale. 1-2 sentences. Examples: 'Runs every 30 minutes during business hours to catch new products quickly without overwhelming the website' or 'Webhook endpoint receives GitHub push events to trigger immediate CI builds'",
        ),
      payloadSchema: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          "JSON Schema defining required payload fields for this signal. Define if signal needs user input, file paths, or parameters. Example: { type: 'object', required: ['user_input'], properties: { user_input: { type: 'string', description: 'User text input or description' } } }. Use snake_case for field names. Omit for schedule-only triggers.",
        ),
      displayLabel: z
        .string()
        .optional()
        .describe("Badge text for UI display (e.g., 'Every Friday at 9am')"),
    }),
  ),

  agents: z.array(
    z.object({
      id: z.string().describe("Kebab-case identifier. Example: 'note-analyzer'"),
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
      capabilities: z
        .array(z.string())
        .describe(
          "Capability IDs from the bundled agents or MCP servers registry. Empty array when built-in tools suffice.",
        ),
      configuration: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          "ONLY user-specific values that must not be lost. Examples: {channel: '#sneaker-drops', email: 'alerts@company.com', targets: ['Nike.com', 'Adidas.com']}. DO NOT include URLs with paths, field names, intervals (already in signal), or implementation details.",
        ),
    }),
  ),

  jobs: z.array(
    z.object({
      id: z.string().describe("Kebab-case identifier. Example: 'process-and-notify'"),
      name: z
        .string()
        .describe(
          "Human-readable job name. Example: 'Monitor and Notify' or 'Process GitHub Events'",
        ),
      title: z
        .string()
        .describe(
          "Short 2-4 word title for UI display. Examples: 'Daily Summary', 'Process Events', 'Send Notifications'",
        ),
      triggerSignalId: z.string().describe("Signal ID that triggers this job"),
      steps: z
        .array(
          z.object({
            agentId: z.string().describe("Agent ID to execute"),
            description: z.string().describe("What this step accomplishes"),
          }),
        )
        .describe("Execution steps in order"),
      behavior: z.enum(["sequential", "parallel", "conditional"]).describe("Execution pattern"),
    }),
  ),
});
export type WorkspacePlan = z.infer<typeof WorkspacePlanSchema>;

/** Calendar schedule data schema */
export const CalendarScheduleSchema = z.object({
  events: z.array(
    z.object({
      id: z
        .string()
        .describe("Unique identifier for the event. Look for an ID key or something similar."),
      eventName: z.string().describe("Name of the event"),
      startDate: z
        .string()
        .describe(
          "Start date of the event (ISO 8601 with timezone offset, e.g. 2024-01-15T09:00:00-08:00)",
        ),
      endDate: z
        .string()
        .describe(
          "End date of the event (ISO 8601 with timezone offset, e.g. 2024-01-15T10:00:00-08:00)",
        ),
      link: z.string().optional().describe("Direct url to the event, if available"),
      attendees: z
        .array(
          z.object({
            email: z.string().describe("Email address of the attendee"),
            responseStatus: z
              .string()
              .optional()
              .describe("RSVP status: needsAction, declined, tentative, or accepted"),
            organizer: z.boolean().optional().describe("Whether this attendee is the organizer"),
          }),
        )
        .optional()
        .describe("List of event attendees with their email addresses and RSVP status"),
    }),
  ),
  source: z.string().describe("Source of the schedule (eg. Google Calendar, iCal, etc.)"),
  sourceUrl: z
    .string()
    .optional()
    .describe("URL of the source of the schedule (eg. Google Calendar URL, iCal URL, etc.)"),
});

export type CalendarSchedule = z.infer<typeof CalendarScheduleSchema>;

/** Summary data schema */
export const SummaryDataSchema = z.string().describe("The content of the summary");
export type SummaryData = z.infer<typeof SummaryDataSchema>;

/** Slack summary data schema */
export const SlackSummaryDataSchema = z.string().describe("The content of the slack summary");
export type SlackSummaryData = z.infer<typeof SlackSummaryDataSchema>;

/** File artifact data (output) */
export const FileDataSchema = z.object({
  path: z.string().describe("Absolute path to the stored file"),
  mimeType: z
    .string()
    .describe("MIME type (e.g., text/csv, application/json). Always populated by storage layer."),
  originalName: z
    .string()
    .optional()
    .describe("Original filename from upload. Optional for backward compatibility."),
});
export type FileData = z.infer<typeof FileDataSchema>;

/** File artifact data (input) - omits mimeType (auto-detected), allows optional originalName */
export const FileDataInputSchema = FileDataSchema.omit({ mimeType: true });
export type FileDataInput = z.infer<typeof FileDataInputSchema>;

/** Table data schema */
export const TableDataSchema = z.object({
  title: z.string().describe("Title for the table"),
  headers: z.array(z.string()).describe("Column headers for the table"),
  rows: z
    .array(z.array(z.string()))
    .describe("Table rows — each row is an array of cell values aligned with headers"),
});
export type TableData = z.infer<typeof TableDataSchema>;

/** Web search data schema */
export const WebSearchDataSchema = z.object({
  response: z.string().describe("Full markdown report"),
  sources: z
    .array(
      z.object({
        siteName: z.string().describe("Website/domain name (e.g. 'Serious Eats', 'Wikipedia')"),
        pageTitle: z.string().describe("Page title or heading"),
        url: z.string().describe("Complete URL of the source"),
      }),
    )
    .describe("Sources found in the reasearch"),
});
export type WebSearchData = z.infer<typeof WebSearchDataSchema>;

/** Mirrors PublishSkillInputSchema — keep validation rules in sync */
export const SkillDraftSchema = z.object({
  name: SkillNameSchema,
  namespace: NamespaceSchema,
  description: z.string().min(1).max(1024),
  instructions: z.string().min(1),
});
export type SkillDraft = z.infer<typeof SkillDraftSchema>;

/** Database schema column - describes a single column in the database table */
export const DatabaseSchemaColumnSchema = z.object({
  name: z.string().describe("Column name"),
  type: z.enum(["TEXT", "INTEGER", "REAL"]).describe("SQLite column type"),
  inferred: z
    .enum(["text", "numeric", "date", "boolean"])
    .optional()
    .describe("Semantic type inferred from column values"),
});
export type DatabaseSchemaColumn = z.infer<typeof DatabaseSchemaColumnSchema>;

/** Database schema - describes table structure and row count */
export const DatabaseSchemaSchema = z.object({
  tableName: z.string().describe("Name of the table in the SQLite database"),
  rowCount: z.number().describe("Total number of rows in the table"),
  columns: z.array(DatabaseSchemaColumnSchema).describe("Column definitions"),
});
export type DatabaseSchema = z.infer<typeof DatabaseSchemaSchema>;

/** Database artifact data - SQLite database converted from CSV */
export const DatabaseDataSchema = z.object({
  path: z.string().describe("Path to SQLite file (local) or cortex://{id} (remote)"),
  sourceFileName: z.string().describe("Original filename for display/download"),
  schema: DatabaseSchemaSchema.describe("Schema metadata for fast access"),
});
export type DatabaseData = z.infer<typeof DatabaseDataSchema>;
