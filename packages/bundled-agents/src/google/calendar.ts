import { env } from "node:process";
import { anthropic } from "@ai-sdk/anthropic";
import type { ToolCall, ToolResult } from "@atlas/agent-sdk";
import { createAgent } from "@atlas/agent-sdk";
import { collectToolUsageFromSteps } from "@atlas/agent-sdk/vercel-helpers";
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
};

export const GoogleCalendarAgentResultSchema = z.object({
  response: z.string(),
  toolCalls: z.array(z.unknown()).optional(),
  toolResults: z.array(z.unknown()).optional(),
});

export const googleCalendarAgent = createAgent<GoogleCalendarAgentResult>({
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
          "Google Calendar json config used by google-calendar-mcp to access Google Calendar APIs",
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
    prompt: string,
    { tools, logger, abortSignal, stream },
  ): Promise<GoogleCalendarAgentResult> => {
    if (!env.ANTHROPIC_API_KEY) {
      throw new Error("ANTHROPIC_API_KEY environment variable is required");
    }

    // 1) Plan the execution and summarization
    const planSchema = z.object({ intent: z.string().min(1) });

    // system should describe how to use the schema
    const plannerSystem = `
      You are a Google Calendar task planner. Analyze the user's prompt and produce a strict JSON plan for the executor and summarizer.
      Remove all pollution from the input data and extract only the relevant information.
      - generic: for all other tasks
      Only plan; do not execute. Use defaults when unsure.
    `;

    const planResult = await generateObject({
      model: anthropic("claude-3-5-haiku-latest"),
      abortSignal,
      system: plannerSystem,
      prompt,
      schema: planSchema,
      temperature: 0,
      maxOutputTokens: 500,
    });

    // this is the intent to send to the next llm call, which will have access to the mcp
    const plan = planResult.object;

    logger.debug("google-calendar plan", { plan });

    const system = `
      You are a Google Calendar assistant. Be concise, direct, and factual. Do not narrate intentions or plans. Never use phrases like 'I'll', 'I will', or 'Let me'. Output only the result without prefacing text. When asked to obtain events, use the available Google Calendar tools to list events if needed. Never fabricate or guess content. Base responses strictly on tool outputs. If tools are unavailable or a tool call fails, respond with a brief factual notice about the limitation (e.g., 'Cannot complete: Google Calendar tools unavailable' or 'Tool call failed: timeout/authorization').

      Execution plan:
      ${JSON.stringify(plan)},

      Follow the plan exactly:
      - Never fabricate. Only use information from tool outputs.
      - If no Google Calendar tools are available, reply: 'Cannot complete: Google Calendar tools unavailable.'
      - If any tool call errors (timeout, authorization, unknown), state the failure briefly and stop.
    `;

    try {
      // Progress: starting execution
      stream?.emit({
        type: "data-tool-progress",
        data: { toolName: "Google Calendar", content: `Executing: ${plan.intent}` },
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
        model: anthropic("claude-3-7-sonnet-latest"),
        abortSignal,
        system,
        prompt: prompt,
        tools,
        maxOutputTokens: 800,
        providerOptions: { anthropic: { thinking: { type: "enabled", budgetTokens: 12000 } } },
        stopWhen: stepCountIs(5),
      });

      const [steps, toolCalls, toolResults] = await Promise.all([
        result.steps,
        result.toolCalls,
        result.toolResults,
      ]);

      const { assembledToolCalls, assembledToolResults } = collectToolUsageFromSteps({
        steps,
        toolCalls,
        toolResults,
      });

      stream?.emit({
        type: "data-tool-progress",
        data: { toolName: "Google Calendar", content: "Execution complete" },
      });

      return {
        response: result.text.trim(),
        toolCalls: assembledToolCalls,
        toolResults: assembledToolResults,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("google-calendar failed", { error: message });
      throw error;
    }
  },
});
