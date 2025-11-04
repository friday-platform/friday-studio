import { env } from "node:process";
import { type ArtifactRef, createAgent } from "@atlas/agent-sdk";
import {
  collectToolUsageFromSteps,
  extractArtifactRefsFromToolResults,
} from "@atlas/agent-sdk/vercel-helpers";
import { anthropic } from "@atlas/core";
import { generateObject, generateText, stepCountIs } from "ai";
import { z } from "zod";
import { executorSystem, planSystem, translateSystem } from "./prompts.ts";

/**
 * Slack Communicator Agent
 *
 * A minimal single-LLM agent intended to be exposed via an MCP server
 * and invoked from Slack through slack-mcp-server. It takes a plain
 * text prompt and returns a concise helpful answer.
 */
type Result = { response: string; artifactRefs: ArtifactRef[] | null };

export const slackCommunicatorAgent = createAgent<string, Result>({
  id: "slack",
  displayName: "Slack",
  version: "1.0.0",
  description:
    "Post messages to Slack channels and DMs; search message history across channels, threads, and conversations; manage channels and users via slack-mcp-server",
  expertise: {
    domains: ["slack"],
    examples: [
      "Post update to #general: Shipping v1.2 today",
      "Send this artifact to #product: {{artifact_id}}",
      // @TODO: move these into a new agent that only handles receive information from Slack
      // "Send DM to @alex asking about deployment status",
      // "Search messages in #engineering from last week about authentication",
      // "List all channels in workspace",
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

  handler: async (prompt, { tools, logger, abortSignal, stream }): Promise<Result> => {
    if (!env.ANTHROPIC_API_KEY) {
      throw new Error("ANTHROPIC_API_KEY environment variable is required");
    }

    let artifactRefs: ArtifactRef[] | null = null;

    // 1) Plan the execution and summarization
    const planSchema = z.object({
      intent: z.string().min(1).describe("The intent of execution"),
      targetChannel: z
        .string()
        .min(1)
        .nullable()
        .default(null)
        .describe("The channel to send or read from"),
      message: z
        .string()
        .min(1)
        .nullable()
        .default(null)
        .describe("The message to send, if provided (optional)"),
      artifactIds: z
        .array(z.string())
        .nullable()
        .default(null)
        .describe("The artifact IDs to read and send, if provided (optional)"),
      additionalContext: z
        .string()
        .min(1)
        .nullable()
        .default(null)
        .describe("Additional context to be used for execution"),
    });

    // Progress: planning
    stream?.emit({
      type: "data-tool-progress",
      data: { toolName: "Slack", content: `Thinking...` },
    });

    const planResult = await generateObject({
      model: anthropic("claude-haiku-4-5"),
      prompt,
      abortSignal,
      system: planSystem,
      schema: planSchema,
      temperature: 0,
      maxOutputTokens: 2000,
    });

    const plan = planResult.object;
    logger.debug("slack-communicator plan", { plan });

    // Check for a message or artifacts and format them if they are available
    if (plan.artifactIds) {
      // Summarizing
      stream?.emit({
        type: "data-tool-progress",
        data: { toolName: "Slack", content: "Formatting summary..." },
      });

      // Summarization: stringify the first-pass result and refine into a final Slack-ready summary
      const translatePrompt = `Read the provided artifact ids and create a Slack mrkdwn compatible artifact, then return the new artifact id. Use the following ids: ${JSON.stringify(plan.artifactIds)}`;

      const { steps, toolCalls, toolResults, text, finishReason } = await generateText({
        model: anthropic("claude-haiku-4-5"),
        abortSignal,
        system: translateSystem,
        prompt: translatePrompt,
        tools,
        maxOutputTokens: 2000,
        providerOptions: { anthropic: { thinking: { type: "enabled", budgetTokens: 12000 } } },
        stopWhen: stepCountIs(10),
      });

      const { assembledToolResults } = collectToolUsageFromSteps({ steps, toolCalls, toolResults });

      artifactRefs = extractArtifactRefsFromToolResults(assembledToolResults);

      logger.info("slack-summarizer summary", { text });

      // Progress: summarization complete
      if (finishReason === "error") {
        logger.error("slack-summarizer failed", { error: text });

        stream?.emit({
          type: "data-tool-progress",
          data: { toolName: "Slack", content: "Failed to summarize the content" },
        });
      }
    }

    // Progress: connecting to Slack
    stream?.emit({
      type: "data-tool-progress",
      data: { toolName: "Slack", content: `Connecting...` },
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

        <content>
          <message>
            ${plan.message ? `${plan.message}` : "Not provided"}
          </message>

          <artifactIds>
            ${artifactRefs ? artifactRefs.map((ref) => ref.id) : "Not provided"}
          </artifactIds>
        </content>

        <additional_context>
          ${plan.additionalContext ? `${plan.additionalContext}` : "Not provided"}
        </additional_context>

        Execute using the available tools to fulfill the intent. If content is present, send both the message and contents of each artifact id to the targetChannel.
      `;

      // Progress: starting execution
      stream?.emit({
        type: "data-tool-progress",
        data: { toolName: "Slack", content: `Executing: ${plan.intent}` },
      });

      // If no tools are available, do not attempt execution; return a clear message.
      if (!tools || Object.keys(tools).length === 0) {
        throw new Error("Cannot complete: Slack tools unavailable");
      }

      const result = await generateText({
        model: anthropic("claude-haiku-4-5"),
        abortSignal,
        system: executorSystem,
        prompt: executorInstructions,
        tools,
        toolChoice: "auto",
        stopWhen: stepCountIs(10),
        maxOutputTokens: 800,
        providerOptions: { anthropic: { thinking: { type: "enabled", budgetTokens: 12000 } } },
      });

      return { response: result.text, artifactRefs };
    } catch (error) {
      logger.error("slack-communicator failed", { error });
      throw error;
    }
  },
});
