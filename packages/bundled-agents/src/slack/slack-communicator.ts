import { env } from "node:process";
import { anthropic } from "@ai-sdk/anthropic";
import type { ToolCall, ToolResult } from "@atlas/agent-sdk";
import { createAgent } from "@atlas/agent-sdk";
import { collectToolUsageFromSteps } from "@atlas/agent-sdk/vercel-helpers";
import { generateObject, generateText, stepCountIs } from "ai";
import { z } from "zod/v4";
import {
  executorSystem,
  plannerSystem as plannerSystemPrompt,
  summarizerSystem,
} from "./prompts.ts";

/**
 * Slack Communicator Agent
 *
 * A minimal single-LLM agent intended to be exposed via an MCP server
 * and invoked from Slack through slack-mcp-server. It takes a plain
 * text prompt and returns a concise helpful answer.
 */
type SlackAgentResult = { response: string; toolCalls?: ToolCall[]; toolResults?: ToolResult[] };

export const slackCommunicatorAgent = createAgent<SlackAgentResult>({
  id: "slack",
  displayName: "Slack",
  version: "1.0.0",
  description:
    "Search and summarize Slack channel, DM, and group DM history, and post messages; includes channels/users lookup via slack-mcp-server",
  expertise: {
    domains: ["slack"],
    examples: [
      "Post update to #general: Shipping v1.2 today; changelog attached.",
      "Share learning to #learning: Great article on idempotent APIs; include key takeaways.",
    ],
  },
  environment: {
    required: [
      {
        name: "SLACK_MCP_XOXP_TOKEN",
        description: "Slack user token used by slack-mcp-server to access Slack APIs",
        validation: "^(xoxb|xoxc|xoxp|xoxd)-",
      },
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
      intent: z.string().min(1).describe("The intent of execution"),
      targetChannel: z
        .string()
        .min(1)
        .nullable()
        .default(null)
        .describe("The channel to send or read from"),
      messageToSend: z.string().min(1).nullable().default(null).describe("The message to send"),
      additionalContext: z
        .string()
        .min(1)
        .nullable()
        .default(null)
        .describe("Additional context to be used for execution"),
      summarizerPurpose: z
        .enum(["summarize_history", "raw_messages", "confirm_send", "generic"])
        .default("generic")
        .describe("What should be an output of execution"),
    });

    stream?.emit({
      type: "data-tool-progress",
      data: { toolName: "Slack", content: `Planning...` },
    });

    const planResult = await generateObject({
      model: anthropic("claude-3-5-haiku-latest"),
      abortSignal,
      system: plannerSystemPrompt,
      prompt,
      schema: planSchema,
      temperature: 0,
      maxOutputTokens: 500,
    });

    const plan = planResult.object;
    logger.debug("slack-communicator plan", { plan });

    stream?.emit({
      type: "data-tool-progress",
      data: { toolName: "Slack", content: `Planning complete` },
    });

    // Removed: dedicated formatter step; formatting is enforced in executor system

    // Progress: planning complete
    stream?.emit({
      type: "data-tool-progress",
      data: { toolName: "Slack", content: `Connecting to Slack...` },
    });

    try {
      // 2) Execute according to plan using tools
      const executorInstructions = `
        <task>
        ${JSON.stringify(plan.intent)}
        </task>

        <channel>
        ${plan.targetChannel ? `${plan.targetChannel}` : "Not provided"}
        </channel>

        <message>
        ${plan.messageToSend ? `${plan.messageToSend}` : "Not provided"}
        </message>

        <additional_context>
        ${plan.additionalContext ? `${plan.additionalContext}` : "Not provided"}
        </additional_context>

        Execute using the available tools to fulfill the intent. If messageToSend is present, send it to the targetChannel.
      `;

      // Progress: starting execution
      stream?.emit({
        type: "data-tool-progress",
        data: { toolName: "Slack", content: `Executing: ${plan.intent}` },
      });

      // If no tools are available, do not attempt execution; return a clear message.
      if (!tools || Object.keys(tools).length === 0) {
        return {
          response: "Cannot complete: Slack tools unavailable.",
          toolCalls: [],
          toolResults: [],
        };
      }

      const result = await generateText({
        model: anthropic("claude-3-7-sonnet-latest"),
        abortSignal,
        system: executorSystem,
        prompt: executorInstructions,
        tools,
        toolChoice: "auto",
        stopWhen: stepCountIs(10),
        maxOutputTokens: 800,
        providerOptions: { anthropic: { thinking: { type: "enabled", budgetTokens: 12000 } } },
      });

      // Get tool calls and results
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

      // Progress: execution complete
      stream?.emit({
        type: "data-tool-progress",
        data: { toolName: "Slack", content: "Summarizing..." },
      });

      const summarizerSchema = z.object({
        response: z.string().min(1).describe("Execution result or error message"),
        failed: z.boolean().nullable().describe("Whether the execution failed"),
      });
      // Second-pass LLM summarization: stringify the first-pass result and refine into a final Slack-ready summary
      const summarizerPrompt = `
      Create execution result basing on following inputs:
      <summarizer_purpose>
      ${JSON.stringify(plan.summarizerPurpose)}
      </summarizer_purpose>
      <model_output>
      ${result.text ? `${result.text.trim()}` : "NO MODEL OUTPUT"}
      </model_output>
      <tool_calls>
      ${toolCalls ? `${JSON.stringify(assembledToolCalls)}` : "NO TOOL CALLS"}
      </tool_calls>
      <tool_results>
      ${toolResults ? `${JSON.stringify(assembledToolResults)}` : "NO TOOL RESULTS"}
      </tool_results>
      `;

      const summarizerResult = await generateObject({
        model: anthropic("claude-3-5-sonnet-latest"),
        abortSignal,
        system: summarizerSystem,
        prompt: summarizerPrompt,
        schema: summarizerSchema,
        temperature: 0.1,
        maxOutputTokens: 800,
      });
      logger.info("slack-communicator refined summary", { text: summarizerResult.object.response });

      // Progress: summarization complete
      stream?.emit({
        type: "data-tool-progress",
        data: { toolName: "Slack", content: "Summary ready" },
      });

      if (summarizerResult.object.failed) {
        logger.error("slack-communicator failed", { error: summarizerResult.object.response });
        stream?.emit({
          type: "data-tool-progress",
          data: { toolName: "Slack", content: "Failed" },
        });
      }

      return {
        response: summarizerResult.object.response,
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
