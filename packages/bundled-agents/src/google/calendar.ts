import { env } from "node:process";
import type { ToolCall, ToolResult } from "@atlas/agent-sdk";
import { createAgent } from "@atlas/agent-sdk";
import {
  collectToolUsageFromSteps,
  extractArtifactRefsFromToolResults,
} from "@atlas/agent-sdk/vercel-helpers";
import { getDefaultProviderOpts, registry } from "@atlas/llm";
import { generateText, stepCountIs } from "ai";
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

export const googleCalendarAgent = createAgent<string, GoogleCalendarAgentResult>({
  id: "google-calendar",
  displayName: "Google Calendar",
  version: "1.0.0",
  description: "Search Google Calendar events via google-calendar-mcp",
  expertise: {
    domains: ["google", "calendar"],
    examples: [
      "Please provide availability looking at both my personal and work calendar for this upcoming week. I am looking for a good time to meet with someone in London for 1 hr.",
      "Which events tomorrow have attendees who have not accepted the invitation?",
      "Get all of my events for today",
      "Get all of my events for next week",
      "Get all of my events for next month",
    ],
  },
  environment: {
    required: [
      {
        name: "GOOGLE_OAUTH_CREDENTIALS",
        description:
          "Google OAuth credentials JSON for Google Calendar API access via Google Calendar MCP Server",
      },
    ],
  },
  // Provide Google Cloud MCP config here so callers (e.g., orchestrator) can merge and use it
  // with google-calendar-mcp using GOOGLE_OAUTH_CREDENTIALS token via npx.
  mcp: {
    "google-cal": {
      transport: { type: "stdio", command: "npx", args: ["-y", "@cocal/google-calendar-mcp"] },
      // @TODO: should this be auto (might be impacted by auth)
      env: { GOOGLE_OAUTH_CREDENTIALS: "auto" },
      client_config: { timeout: { progressTimeout: "2m", maxTotalTimeout: "30m" } },
    },
  },

  handler: async (
    prompt,
    { tools, logger, abortSignal, stream },
  ): Promise<GoogleCalendarAgentResult> => {
    if (!env.ANTHROPIC_API_KEY) {
      throw new Error("ANTHROPIC_API_KEY environment variable is required");
    }

    const system = `
      You are a Google Calendar assistant. Be concise, direct, and factual. Do not narrate intentions or plans. Never use phrases like 'I'll', 'I will', or 'Let me'. Output only the result without prefacing text. When asked to obtain events, use the available Google Calendar tools to list events if needed. Base responses strictly on tool outputs. If tools are unavailable or a tool call fails, respond with a brief factual notice about the limitation (e.g., 'Cannot complete: Google Calendar tools unavailable' or 'Tool call failed: timeout/authorization').
      Follow the plan exactly:
      - Never fabricate information if it is absent. Only use information from tool outputs.
      - If no Google Calendar tools are available, reply: 'Cannot complete: Google Calendar tools unavailable.'
      - If any tool call errors (timeout, authorization, unknown), state the failure briefly and stop.
      - Summarize tool outputs to provide a concise response, including attendees, email addresses, times, locations, and event details, if available.
      - After successfully retrieving calendar events, create an artifact with 'calendar-schedule' type.
      - **Only** return the number of events retrieved in the summary. Never return the the calendar schedule, times of events, or details in the response.
    `;

    try {
      // Progress: starting execution
      stream?.emit({
        type: "data-tool-progress",
        data: { toolName: "Google Calendar", content: `Fetching Calendar` },
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
      });

      logger.debug("AI SDK generateText completed", {
        agent: "google-calendar",
        step: "calendar-query-execution",
        usage: result.usage,
      });

      const { steps, toolCalls, toolResults, text } = result;

      const { assembledToolResults } = collectToolUsageFromSteps({ steps, toolCalls, toolResults });

      const artifactRefs = extractArtifactRefsFromToolResults(assembledToolResults);

      stream?.emit({
        type: "data-outline-update",
        data: {
          id: "google-calendar",
          title: "Calendar",
          icon,
          timestamp: Date.now(),
          artifactId: artifactRefs?.[0]?.id,
          artifactLabel: "View Calendar",
        },
      });

      return { response: text.trim(), artifactRefs };
    } catch (error) {
      logger.error("google-calendar failed", { error });
      throw error;
    }
  },
});
