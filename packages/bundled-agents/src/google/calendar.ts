import { env } from "node:process";
import {
  createAgent,
  createFailTool,
  err,
  type LinkCredentialRef,
  ok,
  repairJson,
  repairToolCall,
} from "@atlas/agent-sdk";
import { collectToolUsageFromSteps } from "@atlas/agent-sdk/vercel-helpers";
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

export const GoogleCalendarOutputSchema = z.object({
  response: z.string().describe("Calendar operation result text"),
});

type GoogleCalendarAgentResult = z.infer<typeof GoogleCalendarOutputSchema>;

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
    return `${scheduleString.substring(0, SUMMARY_MAX_CHARS - 3)}...`;
  }
}

export const googleCalendarAgent = createAgent<string, GoogleCalendarAgentResult>({
  id: "google-calendar",
  displayName: "Google Calendar",
  version: "1.0.0",
  description:
    "Manage Google Calendar - list calendars, search/get events, create new events with attendees and Google Meet, modify existing events, and delete events",
  outputSchema: GoogleCalendarOutputSchema,
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

  handler: async (prompt, { tools, logger, abortSignal, stream, session }) => {
    if (!env.ANTHROPIC_API_KEY && !env.LITELLM_API_KEY) {
      return err("ANTHROPIC_API_KEY or LITELLM_API_KEY environment variable is required");
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
- If you cannot complete the request, call the fail tool with a clear reason.
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

    // Failure tracking for fail tool
    const state: { failure: { reason: string } | null } = { failure: null };

    const failTool = createFailTool({
      onFail: ({ reason }) => {
        state.failure = { reason };
      },
      description:
        "Signal that the calendar operation cannot be completed. Use when required information is missing, the calendar is inaccessible, or the request is impossible to fulfill.",
    });

    try {
      // Progress: starting execution
      stream?.emit({
        type: "data-tool-progress",
        data: { toolName: "Google Calendar", content: `Processing calendar request` },
      });

      // If no tools are available, do not attempt execution; return a clear message.
      if (!tools || Object.keys(tools).length === 0) {
        return err(
          "Cannot complete: Google Calendar tools unavailable. Provide Google Calendar MCP tools to proceed.",
        );
      }

      const result = await generateText({
        model: registry.languageModel("anthropic:claude-haiku-4-5"),
        abortSignal,
        messages: [
          { role: "system", content: system, providerOptions: getDefaultProviderOpts("anthropic") },
          { role: "user", content: prompt },
        ],
        tools: { ...tools, fail: failTool },
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

      // Collect tool usage from the result (helper handles steps vs top-level fallback)
      const { assembledToolCalls, assembledToolResults } = collectToolUsageFromSteps({
        steps: result.steps,
        toolCalls: result.toolCalls,
        toolResults: result.toolResults,
      });

      // Check if the agent signaled failure
      if (state.failure) {
        return err(state.failure.reason);
      }

      // Determine what operations were performed from assembled tool calls
      const calledToolNames = new Set(assembledToolCalls.map((tc) => tc.toolName));
      const writeToolNames = new Set(["create_event", "modify_event", "delete_event"]);
      const calledWriteTools = [...calledToolNames].some((name) => writeToolNames.has(name));
      const calledGetEvents = calledToolNames.has("get_events");

      // Only create artifact if get_events was called AND no write operations were performed
      if (calledGetEvents && !calledWriteTools) {
        const { object: calendarData } = await generateObject({
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
          return err(
            `Failed to create calendar artifact: ${stringifyError(artifactResponse.error)}`,
          );
        }

        const artifact = artifactResponse.data.artifact;

        return ok(
          { response: "" },
          {
            toolCalls: assembledToolCalls,
            toolResults: assembledToolResults,
            artifactRefs: [{ id: artifact.id, type: artifact.type, summary: artifact.summary }],
            outlineRefs: [
              {
                service: "google-calendar",
                title: "Calendar retrieved",
                content: summary,
                artifactId: artifact.id,
                artifactLabel: "View Calendar",
                type: "calendar-schedule",
              },
            ],
          },
        );
      }

      // No artifact for write operations or when get_events wasn't called
      return ok(
        { response: result.text.trim() },
        { toolCalls: assembledToolCalls, toolResults: assembledToolResults },
      );
    } catch (error) {
      logger.error("google-calendar failed", { error });
      return err(stringifyError(error));
    }
  },
});
