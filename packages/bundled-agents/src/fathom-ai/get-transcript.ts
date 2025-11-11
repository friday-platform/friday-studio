import { env } from "node:process";
import { createAgent } from "@atlas/agent-sdk";
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

type FathomGetTranscriptResult = {
  response: string;
  artifactRefs?: Array<{ id: string; type: string; summary: string }>;
};

export const fathomGetTranscriptAgent = createAgent<string, FathomGetTranscriptResult>({
  id: "fathom-get-transcript",
  displayName: "Fathom Get Transcript",
  version: "1.0.0",
  description: "Get the latest meeting from Fathom AI and retrieve its transcript",
  expertise: {
    domains: ["fathom", "meetings", "transcripts"],
    examples: [
      "Get the transcript of my latest Fathom meeting",
      "Show me the most recent meeting transcript",
      "What was discussed in my last meeting?",
    ],
  },
  environment: {
    required: [{ name: "FATHOM_API_KEY", description: "Fathom AI API key for authentication" }],
  },

  handler: async (_, { logger, stream }): Promise<FathomGetTranscriptResult> => {
    if (!env.FATHOM_API_KEY) {
      throw new Error("FATHOM_API_KEY environment variable is required");
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
        throw new Error(
          `Fathom API error: ${meetingsResponse.status} ${meetingsResponse.statusText}`,
        );
      }

      const meetingsData = await meetingsResponse.json();
      const meetings = MeetingsResponseSchema.parse(meetingsData);

      if (!meetings.items || meetings.items.length === 0) {
        return { response: "No meetings found in Fathom AI" };
      }

      // Get the latest meeting (first item in the list)
      const latestMeeting = meetings.items[0];

      if (!latestMeeting || !latestMeeting.recording_id) {
        return { response: "Latest meeting has no recording ID available" };
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
        throw new Error(
          `Fathom transcript API error: ${transcriptResponse.status} ${transcriptResponse.statusText}`,
        );
      }

      const transcriptData = await transcriptResponse.json();
      const transcript = TranscriptResponseSchema.parse(transcriptData);

      logger.info(`Retrieved transcript with ${transcript.transcript.length} items`);

      const transcriptText = transcript.transcript
        .map((item) => `[${item.timestamp}] ${item.speaker.display_name}: ${item.text}`)
        .join("\n");

      return {
        response: `Latest meeting: "${latestMeeting.title}"\n\nTranscript:\n${transcriptText}`,
      };
    } catch (error) {
      logger.error("fathom-list-meetings failed", { error });
      throw error;
    }
  },
});
