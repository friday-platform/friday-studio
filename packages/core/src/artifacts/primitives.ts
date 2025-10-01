import { z } from "zod";

/** Workspace plan data schema */
export const WorkspacePlanSchema = z.object({});
export type WorkspacePlan = z.infer<typeof WorkspacePlanSchema>;

/** Calendar schedule data schema */
export const CalendarScheduleSchema = z.object({
  events: z.array(
    z.object({
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
