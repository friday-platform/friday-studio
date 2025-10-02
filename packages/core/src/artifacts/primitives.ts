import { z } from "zod";

/** Workspace plan data schema */
/** Workspace plan data schema - prose descriptions of workspace structure */
export const WorkspacePlanSchema = z.object({
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
      id: z.string().describe("Kebab-case identifier. Example: 'new-note-detected'"),
      name: z
        .string()
        .describe("Human-readable signal name. Example: 'Check Schedule' or 'GitHub Push Event'"),
      description: z
        .string()
        .describe(
          "When and how this triggers, including rationale. 1-2 sentences. Examples: 'Runs every 30 minutes during business hours to catch new products quickly without overwhelming the website' or 'Webhook endpoint receives GitHub push events to trigger immediate CI builds'",
        ),
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

  jobs: z.array(
    z.object({
      id: z.string().describe("Kebab-case identifier. Example: 'process-and-notify'"),
      name: z
        .string()
        .describe(
          "Human-readable job name. Example: 'Monitor and Notify' or 'Process GitHub Events'",
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
      startDate: z.iso.datetime().describe("Start date of the event (ISO 8601 accepted)"),
      endDate: z.iso.datetime().describe("End date of the event (ISO 8601 accepted)"),
      link: z.string().optional().describe("Direct url to the event, if available"),
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
