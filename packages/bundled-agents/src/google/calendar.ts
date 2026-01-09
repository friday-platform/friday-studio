import { env } from "node:process";
import type { LinkCredentialRef, ToolCall, ToolResult } from "@atlas/agent-sdk";
import { createAgent, repairJson, repairToolCall } from "@atlas/agent-sdk";
import { client, parseResult } from "@atlas/client/v2";
import { type CalendarSchedule, CalendarScheduleSchema } from "@atlas/core/artifacts";
import { getDefaultProviderOpts, registry, smallLLM } from "@atlas/llm";
import { stringifyError } from "@atlas/utils";
import { generateObject, generateText, stepCountIs } from "ai";
import { z } from "zod";

/**
 * Google Calendar Agent
 *
 * A minimal single-LLM agent intended to be exposed via an MCP server
 * and invoked from Google Calendar through google-calendar-mcp. It takes a plain
 * text prompt and returns a concise helpful answer.
 */
type GoogleCalendarAgentResult = {
  response: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  artifactRefs?: Array<{ id: string; type: string; summary: string }>;
};

export const GoogleCalendarAgentResultSchema = z.object({
  response: z.string(),
  toolCalls: z.array(z.unknown()).optional(),
  toolResults: z.array(z.unknown()).optional(),
});

const icon =
  "data:image/png;base64,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";

/** Max characters for summary (schema max is 5000, leave buffer) */
const SUMMARY_MAX_CHARS = 4500;

/**
 * Generate a rich summary with actual event names and times.
 * Tier 1: Direct format if fits in char limit.
 * Tier 2: Use smallLLM to compress while preserving all event names.
 */
async function generateCalendarSummary(
  schedule: CalendarSchedule,
  abortSignal?: AbortSignal,
): Promise<string> {
  const events = schedule.events;
  if (events.length === 0) {
    return "No events scheduled";
  }

  const scheduleString = JSON.stringify(schedule);

  // If tier 1 fits, use it directly
  if (scheduleString.length <= SUMMARY_MAX_CHARS) {
    return scheduleString;
  }

  // Tier 2: Use smallLLM to compress while preserving all event names and times
  try {
    const compressed = await smallLLM({
      system: `You compress calendar event lists into concise summaries. CRITICAL RULES:
1. NEVER drop any event - every event name must appear
2. Preserve all times (use short format like 9am, 2:30pm)
3. Preserve all event details (attendees, location) if possible
2. Be extremely concise. Sacrifice grammar for the sake of concision
5. Keep under ${SUMMARY_MAX_CHARS} characters`,
      prompt: `Compress this calendar summary:\n${scheduleString}`,
      abortSignal,
      maxOutputTokens: 500,
    });
    return compressed.trim().substring(0, SUMMARY_MAX_CHARS);
  } catch {
    // Fallback: truncate tier 1 summary
    return scheduleString.substring(0, SUMMARY_MAX_CHARS - 3) + "...";
  }
}

export const googleCalendarAgent = createAgent<string, GoogleCalendarAgentResult>({
  id: "google-calendar",
  displayName: "Google Calendar",
  version: "1.0.0",
  description:
    "Manage Google Calendar - list calendars, search/get events, create new events with attendees and Google Meet, modify existing events, and delete events",
  expertise: {
    domains: ["calendar", "schedule", "meetings", "events", "availability", "scheduling"],
    examples: [
      "Get all of my events for today",
      "Create a meeting with john@example.com tomorrow at 2pm for 1 hour",
      "Schedule a team standup every Monday at 9am with Google Meet",
      "Move my 3pm meeting to 4pm",
      "Delete the meeting with Sarah",
      "What's on my calendar this week?",
      "Add Jane to the project kickoff meeting",
    ],
  },
  environment: {
    required: [
      {
        name: "GOOGLE_CALENDAR_ACCESS_TOKEN",
        description: "Google Calendar OAuth access token from Link",
        linkRef: { provider: "google-calendar", key: "access_token" },
      },
    ],
  },
  // MCP config for Google Calendar via workspace-mcp HTTP transport
  mcp: {
    "google-calendar": {
      transport: { type: "http", url: env.GOOGLE_WORKSPACE_MCP_URL || "http://localhost:8000/mcp" },
      auth: { type: "bearer", token_env: "GOOGLE_CALENDAR_ACCESS_TOKEN" },
      env: {
        GOOGLE_CALENDAR_ACCESS_TOKEN: {
          from: "link",
          provider: "google-calendar",
          key: "access_token",
        } satisfies LinkCredentialRef,
      },
      client_config: { timeout: { progressTimeout: "2m", maxTotalTimeout: "30m" } },
    },
  },

  handler: async (
    prompt,
    { tools, logger, abortSignal, stream, session },
  ): Promise<GoogleCalendarAgentResult> => {
    if (!env.ANTHROPIC_API_KEY && !env.LITELLM_API_KEY) {
      throw new Error("ANTHROPIC_API_KEY or LITELLM_API_KEY environment variable is required");
    }

    const system = `You are a Google Calendar assistant. Be concise, direct, and factual.

Available capabilities:
- list_calendars: List all accessible calendars
- get_events: Search and retrieve calendar events (by time range, query, or event ID)
- create_event: Create new events with attendees, Google Meet, reminders, attachments
- modify_event: Update existing events (title, time, attendees, location, etc.)
- delete_event: Remove events from calendar

Rules:
- Never fabricate information. Only use tool outputs.
- If no tools available: 'Cannot complete: Google Calendar tools unavailable.'
- If tool errors: state failure briefly and stop.
- For READ operations: Filter tool results to only include events matching the user's request. YOU MUST KEEP the original response intact.
- For WRITE operations: Confirm with event title, time, and link.
- When creating events with attendees, use email addresses.
- For Google Meet, set add_google_meet=true.
- For modify/delete: first get_events to find event ID, then modify/delete.

Filtering events:
When calling get_events, you MUST set the "time_min" value:
  - Use the user's Local Timezone Offset from Context Facts to construct the time_min bound.
  - If the user asks for their schedule today, start at midnight
  - If the user asks for their upcoming events, start at the current time
This ensures events later in the day aren't excluded due to UTC date boundary, and that past events are shown when the user requests their calendar for the full day.`;

    try {
      // Progress: starting execution
      stream?.emit({
        type: "data-tool-progress",
        data: { toolName: "Google Calendar", content: `Processing calendar request` },
      });

      // If no tools are available, do not attempt execution; return a clear message.
      if (!tools || Object.keys(tools).length === 0) {
        return {
          response:
            "Cannot complete: Google Calendar tools unavailable. Provide Google Calendar MCP tools to proceed.",
          toolCalls: [],
          toolResults: [],
        };
      }

      const result = await generateText({
        model: registry.languageModel("anthropic:claude-haiku-4-5"),
        abortSignal,
        messages: [
          { role: "system", content: system, providerOptions: getDefaultProviderOpts("anthropic") },
          { role: "user", content: prompt },
        ],
        tools,
        maxOutputTokens: 3000,
        providerOptions: { anthropic: { thinking: { type: "enabled", budgetTokens: 12000 } } },
        stopWhen: stepCountIs(20),
        experimental_repairToolCall: repairToolCall,
      });

      logger.debug("AI SDK generateText completed", {
        agent: "google-calendar",
        step: "calendar-query-execution",
        usage: result.usage,
      });

      const { steps, text } = result;

      // Extract tool names from all steps to determine what operations were performed
      const calledToolNames = new Set<string>();
      for (const step of steps) {
        if (step.toolCalls) {
          for (const tc of step.toolCalls) {
            calledToolNames.add(tc.toolName);
          }
        }
      }

      const writeToolNames = new Set(["create_event", "modify_event", "delete_event"]);
      const calledWriteTools = [...calledToolNames].some((name) => writeToolNames.has(name));
      const calledGetEvents = calledToolNames.has("get_events");

      // Only create artifact if get_events was called AND no write operations were performed
      if (calledGetEvents && !calledWriteTools) {
        const extractionResult = await generateObject({
          model: registry.languageModel("anthropic:claude-haiku-4-5"),
          schema: CalendarScheduleSchema,
          experimental_repairText: repairJson,
          abortSignal,
          messages: [
            {
              role: "system",
              content: `Extract all calendar events from the tool results into the schema. Set source to "Google Calendar". If no events found, return an empty events array.`,
              providerOptions: getDefaultProviderOpts("anthropic"),
            },
            { role: "user", content: `Extract all events from:\n${result.text}` },
          ],
        });

        const calendarData = extractionResult.object;

        // Generate rich summary with actual event names and times
        const summary = await generateCalendarSummary(calendarData, abortSignal);

        // Create artifact via direct API call
        const artifactResponse = await parseResult(
          client.artifactsStorage.index.$post({
            json: {
              data: { type: "calendar-schedule", version: 1, data: calendarData },
              title: "Calendar Schedule",
              summary,
              workspaceId: session.workspaceId,
              chatId: session.streamId,
            },
          }),
        );

        if (!artifactResponse.ok) {
          throw new Error(
            `Failed to create calendar artifact: ${stringifyError(artifactResponse.error)}`,
          );
        }

        const artifactId = artifactResponse.data.artifact.id;

        stream?.emit({
          type: "data-outline-update",
          data: {
            id: "google-calendar",
            content: summary,
            title: "Calendar retrieved",
            icon,
            timestamp: Date.now(),
            artifactId,
            artifactLabel: "View Calendar",
          },
        });

        return {
          response: "",
          artifactRefs: [{ id: artifactId, type: "calendar-schedule", summary }],
        };
      }

      // No artifact for write operations or when get_events wasn't called
      return { response: text.trim() };
    } catch (error) {
      logger.error("google-calendar failed", { error });
      throw error;
    }
  },
});
