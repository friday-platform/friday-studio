import { env } from "node:process";
import { anthropic } from "@ai-sdk/anthropic";
import { createAgent } from "@atlas/agent-sdk";
import type { ToolCall, ToolResult } from "@atlas/agent-sdk";
import { collectToolUsageFromSteps } from "@atlas/agent-sdk/vercel-helpers";
import { generateObject, generateText } from "ai";
import { z } from "zod";

/**
 * Slack Communicator Agent
 *
 * A minimal single-LLM agent intended to be exposed via an MCP server
 * and invoked from Slack through slack-mcp-server. It takes a plain
 * text prompt and returns a concise helpful answer.
 */
export type SlackAgentResult = {
  response: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
};

export const SlackAgentResultSchema = z.object({
  response: z.string(),
  toolCalls: z.array(z.unknown()).optional(),
  toolResults: z.array(z.unknown()).optional(),
});

export const slackCommunicatorAgent = createAgent<SlackAgentResult>({
  id: "slack",
  displayName: "Slack",
  version: "1.0.0",
  description: "Can read and write to Slack channels and DMs",
  expertise: {
    domains: ["slack"],
    examples: [
      "Post update to #general: Shipping v1.2 today; changelog attached.",
      "Share learning to #learning: Great article on idempotent APIs; include key takeaways.",
    ],
  },
  // Provide Slack MCP config here so callers (e.g., orchestrator) can merge and use it
  // with slack-mcp-server using XOXP token via npx.
  mcp: {
    slack: {
      transport: { type: "stdio", command: "npx", args: ["-y", "slack-mcp-server@latest"] },
      env: { SLACK_MCP_XOXP_TOKEN: "auto", SLACK_MCP_ADD_MESSAGE_TOOL: "true" },
      client_config: { timeout: { progressTimeout: "2m", maxTotalTimeout: "30m" } },
    },
  },

  handler: async (
    prompt: string,
    { tools, logger, abortSignal, stream },
  ): Promise<SlackAgentResult> => {
    if (!env.ANTHROPIC_API_KEY) {
      throw new Error("ANTHROPIC_API_KEY environment variable is required");
    }

    // 1) Plan the execution and summarization
    const planSchema = z.object({
      intent: z.string().min(1),
      targetChannel: z.string().min(1).nullable().default(null),
      needsHistory: z.boolean().default(false),
      historyLimit: z.number().int().min(1).max(200).default(50),
      includeActivityMessages: z.boolean().default(true),
      messageToSend: z.string().min(1).nullable().default(null),
      summarizerPurpose: z
        .enum(["summarize_history", "raw_messages", "confirm_send", "generic"])
        .default("generic"),
    });

    const plannerSystem =
      "You are a Slack task planner. Analyze the user's prompt and produce a strict JSON plan for the executor and summarizer. " +
      "If a #channel is specified, put it in targetChannel; else null. Set needsHistory true when the user asks to check/summary channel messages. " +
      "Remove all pollution from the input data and extract only the relevant information. " +
      "Set messageToSend when the user asks to draft/post text. Choose summarizerPurpose based on the task: summarize_history, raw_messages, confirm_send, or generic. " +
      "Only plan; do not execute. Use defaults when unsure.";

    const planResult = await generateObject({
      model: anthropic("claude-3-5-haiku-latest"),
      abortSignal,
      system: plannerSystem,
      prompt,
      schema: planSchema,
      temperature: 0,
      maxOutputTokens: 500,
    });

    const plan = planResult.object;

    // Progress: planning complete
    stream?.emit({
      type: "data-tool-progress",
      data: {
        toolName: "Slack",
        content: `Planned: ${plan.intent}${plan.targetChannel ? ` → ${plan.targetChannel}` : ""}; summarizer: ${plan.summarizerPurpose}`,
      },
    });

    const system =
      "You are a Slack assistant. Be concise, direct, and factual. " +
      "Use short paragraphs or bullets and avoid heavy markdown. " +
      "If the user specifies a #channel, use it. Otherwise, choose the most relevant existing channel; default to #general if unclear. " +
      "When asked to check recent messages or channel history, immediately use the Slack tools to retrieve the last 20–50 messages from the target channel, then return a concise summary of the conversation. " +
      "Your summary should include: key topics, decisions, action items (with owners/dates if present), blockers, and important links. Optionally include the last 3–5 messages with author and short timestamp. " +
      "Do not narrate intentions or plans. Never use phrases like 'I'll', 'I will', or 'Let me'. Output only the result without prefacing text. " +
      "If the channel is ambiguous, ask one brief clarifying question. " +
      "When asked to post or draft a message, use the available Slack tools to list channels if needed and send the composed message to the chosen channel. " +
      "Never fabricate or guess content. Base responses strictly on tool outputs. If tools are unavailable or a tool call fails, respond with a brief factual notice about the limitation (e.g., 'Cannot complete: Slack tools unavailable' or 'Tool call failed: timeout/authorization').";

    try {
      // 2) Execute according to plan using tools
      const executorInstructions = [
        "Execution plan:",
        JSON.stringify(plan),
        "Follow the plan exactly:",
        "- If needsHistory is true, you MUST call conversations_history with targetChannel (or ask briefly if null), limit=historyLimit, include_activity_messages accordingly, BEFORE producing any user-facing text.",
        "- If messageToSend is present, call conversations_add_message with targetChannel and the message.",
        "- Avoid narration entirely; focus on tool calls and minimal final text (the summarizer will produce the user-facing output).",
        "- Never fabricate. Only use information from tool outputs.",
        "- If summarizerPurpose is summarize_history or raw_messages and you did not successfully fetch history, reply briefly: 'Cannot complete: no history fetched.'",
        "- If no Slack tools are available, reply: 'Cannot complete: Slack tools unavailable.'",
        "- If any tool call errors (timeout, authorization, unknown), state the failure briefly and stop.",
      ].join("\n");

      // Progress: starting execution
      stream?.emit({
        type: "data-tool-progress",
        data: {
          toolName: "Slack",
          content: `Executing: ${plan.needsHistory ? `fetch history (${plan.historyLimit})` : "no history"}${plan.messageToSend ? ", send message" : ""}`,
        },
      });

      // If no tools are available, do not attempt execution; return a clear message.
      if (!tools || Object.keys(tools).length === 0) {
        return {
          response: "Cannot complete: Slack tools unavailable. Provide Slack MCP tools to proceed.",
          toolCalls: [],
          toolResults: [],
        };
      }

      const result = await generateText({
        model: anthropic("claude-3-7-sonnet-latest"),
        abortSignal,
        system,
        prompt: [prompt, "\n\n", executorInstructions].join(""),
        tools,
        temperature: 0,
        maxOutputTokens: 800,
        providerOptions: { anthropic: { thinking: { type: "enabled", budgetTokens: 12000 } } },
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

      // Progress: execution complete
      stream?.emit({
        type: "data-tool-progress",
        data: { toolName: "Slack", content: "Execution complete" },
      });

      // Second-pass LLM summarization: stringify the first-pass result and refine into a final Slack-ready summary
      const serialized = JSON.stringify(result);
      const summarizerSystem =
        "You are a Slack summary refiner. Use the plan to decide the exact output style. " +
        "- summarizerPurpose = summarize_history: Produce a structured summary with sections (channel/timeframe, participants, key topics, decisions, action items with owners/dates, blockers, important links, recent 3–5 messages: author — short timestamp — brief text).\n" +
        "- summarizerPurpose = raw_messages: Output the most relevant raw messages in a concise, readable list with author and timestamp (3–20 messages based on plan.historyLimit).\n" +
        "- summarizerPurpose = confirm_send: Confirm the message was sent, include channel, a short excerpt, and timestamp/thread info if available.\n" +
        "- summarizerPurpose = generic: Provide a concise, helpful response summarizing what happened.\n" +
        "Rules: no narration; output only the final content; be concise and factual; omit unknowns. For summarize_history or raw_messages, rely ONLY on TOOL_OUTPUT and ignore MODEL_OUTPUT; if TOOL_OUTPUT contains no fetched history/messages, respond: 'Cannot complete: no history fetched.'";

      const context = [
        `PLAN:\n${JSON.stringify(plan)}`,
        `PROMPT:\n${prompt.trim()}`,
        result.text ? `MODEL_OUTPUT:\n${result.text.trim()}` : "",
        `TOOL_OUTPUT:\n${serialized}`,
      ]
        .filter((s) => s.length > 0)
        .join("\n\n");

      // Progress: starting summarization
      stream?.emit({
        type: "data-tool-progress",
        data: { toolName: "Slack", content: `Summarizing (${plan.summarizerPurpose})` },
      });

      const refined = await generateText({
        model: anthropic("claude-3-5-sonnet-latest"),
        abortSignal,
        system: summarizerSystem,
        prompt: context,
        temperature: 0.1,
        maxOutputTokens: 800,
      });

      const finalText = refined.text.trim();
      logger.info("slack-communicator refined summary", { text: finalText });
      // Progress: summarization complete
      stream?.emit({
        type: "data-tool-progress",
        data: { toolName: "Slack", content: "Summary ready" },
      });
      return {
        response: finalText.length > 0 ? finalText : result.text.trim(),
        toolCalls: assembledToolCalls,
        toolResults: assembledToolResults,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("slack-communicator failed", { error: message });
      throw error;
    }
  },
});
