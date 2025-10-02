import { z } from "zod";

/** Workspace plan data schema */
export const WorkspacePlanSchema = z.object({});
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
