import { env } from "node:process";
import { createAgent, err, ok } from "@atlas/agent-sdk";
import { stringifyError } from "@atlas/utils";
import { z } from "zod";

/**
 * Fathom AI Get Transcript Agent
 *
 * Gets the latest meeting transcript from Fathom AI and retrieves the transcript of the latest meeting.
 */

const MeetingSchema = z.object({
  title: z.string(),
  meeting_title: z.string(),
  url: z.string(),
  created_at: z.string(),
  scheduled_start_time: z.string().nullable(),
  scheduled_end_time: z.string().nullable(),
  recording_id: z.number(),
  recording_start_time: z.string().nullable(),
  recording_end_time: z.string().nullable(),
  calendar_invitees_domains_type: z.string().nullable(),
  transcript: z.unknown().nullable(),
  transcript_language: z.string().nullable(),
  default_summary: z.unknown().nullable(),
  action_items: z.unknown().nullable(),
  calendar_invitees: z.array(z.unknown()).nullable(),
  recorded_by: z.unknown().nullable(),
  share_url: z.string().nullable(),
  crm_matches: z.unknown().nullable(),
});

const MeetingsResponseSchema = z.object({
  items: z.array(MeetingSchema),
  next_cursor: z.string(),
  limit: z.number(),
});

const TranscriptItemSchema = z.object({
  speaker: z.object({
    display_name: z.string(),
    matched_calendar_invitee_email: z.string().nullable(),
  }),
  text: z.string(),
  timestamp: z.string(),
});

const TranscriptResponseSchema = z.object({ transcript: z.array(TranscriptItemSchema) });

export const FathomOutputSchema = z.object({
  response: z.string().describe("Meeting title and transcript text"),
});

type FathomGetTranscriptResult = z.infer<typeof FathomOutputSchema>;

export const fathomGetTranscriptAgent = createAgent<string, FathomGetTranscriptResult>({
  id: "fathom-get-transcript",
  displayName: "Fathom Get Transcript",
  version: "1.0.0",
  summary:
    "Fetch the latest meeting transcript from Fathom AI with speaker attribution and timestamps.",
  description:
    "Fetches the latest meeting recording from Fathom AI and retrieves its full transcript with speaker attribution and timestamps. USE FOR: getting meeting transcripts, reviewing what was discussed in meetings.",
  constraints:
    "Fathom AI meetings only. Retrieves the single most recent meeting transcript. Cannot search by date or meeting title. For calendar events and scheduling, use google-calendar.",
  outputSchema: FathomOutputSchema,
  expertise: {
    examples: [
      "Get the transcript of my latest Fathom meeting",
      "Show me the most recent meeting transcript",
      "What was discussed in my last meeting?",
    ],
  },
  environment: {
    required: [{ name: "FATHOM_API_KEY", description: "Fathom AI API key for authentication" }],
  },

  handler: async (_input, { logger, stream }) => {
    if (!env.FATHOM_API_KEY) {
      return err("FATHOM_API_KEY environment variable is required");
    }

    try {
      stream?.emit({
        type: "data-tool-progress",
        data: { toolName: "Fathom List Meetings", content: `Fetching meetings` },
      });

      const meetingsResponse = await fetch("https://api.fathom.ai/external/v1/meetings", {
        method: "GET",
        headers: { "X-Api-Key": env.FATHOM_API_KEY },
      });

      if (!meetingsResponse.ok) {
        return err(`Fathom API error: ${meetingsResponse.status} ${meetingsResponse.statusText}`);
      }

      const meetings = MeetingsResponseSchema.parse(await meetingsResponse.json());

      if (!meetings.items || meetings.items.length === 0) {
        return ok({ response: "No meetings found in Fathom AI" });
      }

      const latestMeeting = meetings.items[0];

      if (!latestMeeting || !latestMeeting.recording_id) {
        return ok({ response: "Latest meeting has no recording ID available" });
      }

      logger.info(`Latest meeting: ${latestMeeting.title} (ID: ${latestMeeting.recording_id})`);

      stream?.emit({
        type: "data-tool-progress",
        data: {
          toolName: "Fathom List Meetings",
          content: `Fetching transcript for "${latestMeeting.title}"`,
        },
      });

      const transcriptResponse = await fetch(
        `https://api.fathom.ai/external/v1/recordings/${latestMeeting.recording_id}/transcript`,
        { method: "GET", headers: { "X-Api-Key": env.FATHOM_API_KEY } },
      );

      if (!transcriptResponse.ok) {
        return err(
          `Fathom transcript API error: ${transcriptResponse.status} ${transcriptResponse.statusText}`,
        );
      }

      const transcript = TranscriptResponseSchema.parse(await transcriptResponse.json());

      logger.info(`Retrieved transcript with ${transcript.transcript.length} items`);

      const transcriptText = transcript.transcript
        .map((item) => `[${item.timestamp}] ${item.speaker.display_name}: ${item.text}`)
        .join("\n");

      return ok({
        response: `Latest meeting: "${latestMeeting.title}"\n\nTranscript:\n${transcriptText}`,
      });
    } catch (error) {
      logger.error("fathom-get-transcript failed", { error });
      return err(stringifyError(error));
    }
  },
});
