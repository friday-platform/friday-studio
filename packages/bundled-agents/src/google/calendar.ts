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

      return { response: text.trim(), artifactRefs };
    } catch (error) {
      logger.error("google-calendar failed", { error });
      throw error;
    }
  },
});
