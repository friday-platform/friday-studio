import { env } from "node:process";
import { type ArtifactRef, createAgent, repairJson } from "@atlas/agent-sdk";
import {
  collectToolUsageFromSteps,
  extractArtifactRefsFromToolResults,
} from "@atlas/agent-sdk/vercel-helpers";
import { getDefaultProviderOpts, registry } from "@atlas/llm";
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

const icon =
  "data:image/svg+xml;base64,PHN2ZyBlbmFibGUtYmFja2dyb3VuZD0ibmV3IDAgMCAyNDQ3LjYgMjQ1Mi41IiB2aWV3Qm94PSIwIDAgMjQ0Ny42IDI0NTIuNSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48ZyBjbGlwLXJ1bGU9ImV2ZW5vZGQiIGZpbGwtcnVsZT0iZXZlbm9kZCI+PHBhdGggZD0ibTg5Ny40IDBjLTEzNS4zLjEtMjQ0LjggMTA5LjktMjQ0LjcgMjQ1LjItLjEgMTM1LjMgMTA5LjUgMjQ1LjEgMjQ0LjggMjQ1LjJoMjQ0Ljh2LTI0NS4xYy4xLTEzNS4zLTEwOS41LTI0NS4xLTI0NC45LTI0NS4zLjEgMCAuMSAwIDAgMG0wIDY1NGgtNjUyLjZjLTEzNS4zLjEtMjQ0LjkgMTA5LjktMjQ0LjggMjQ1LjItLjIgMTM1LjMgMTA5LjQgMjQ1LjEgMjQ0LjcgMjQ1LjNoNjUyLjdjMTM1LjMtLjEgMjQ0LjktMTA5LjkgMjQ0LjgtMjQ1LjIuMS0xMzUuNC0xMDkuNS0yNDUuMi0yNDQuOC0yNDUuM3oiIGZpbGw9IiMzNmM1ZjAiLz48cGF0aCBkPSJtMjQ0Ny42IDg5OS4yYy4xLTEzNS4zLTEwOS41LTI0NS4xLTI0NC44LTI0NS4yLTEzNS4zLjEtMjQ0LjkgMTA5LjktMjQ0LjggMjQ1LjJ2MjQ1LjNoMjQ0LjhjMTM1LjMtLjEgMjQ0LjktMTA5LjkgMjQ0LjgtMjQ1LjN6bS02NTIuNyAwdi02NTRjLjEtMTM1LjItMTA5LjQtMjQ1LTI0NC43LTI0NS4yLTEzNS4zLjEtMjQ0LjkgMTA5LjktMjQ0LjggMjQ1LjJ2NjU0Yy0uMiAxMzUuMyAxMDkuNCAyNDUuMSAyNDQuNyAyNDUuMyAxMzUuMy0uMSAyNDQuOS0xMDkuOSAyNDQuOC0yNDUuM3oiIGZpbGw9IiMyZWI2N2QiLz48cGF0aCBkPSJtMTU1MC4xIDI0NTIuNWMxMzUuMy0uMSAyNDQuOS0xMDkuOSAyNDQuOC0yNDUuMi4xLTEzNS4zLTEwOS41LTI0NS4xLTI0NC44LTI0NS4yaC0yNDQuOHYyNDUuMmMtLjEgMTM1LjIgMTA5LjUgMjQ1IDI0NC44IDI0NS4yem0wLTY1NC4xaDY1Mi43YzEzNS4zLS4xIDI0NC45LTEwOS45IDI0NC44LTI0NS4yLjItMTM1LjMtMTA5LjQtMjQ1LjEtMjQ0LjctMjQ1LjNoLTY1Mi43Yy0xMzUuMy4xLTI0NC45IDEwOS45LTI0NC44IDI0NS4yLS4xIDEzNS40IDEwOS40IDI0NS4yIDI0NC43IDI0NS4zeiIgZmlsbD0iI2VjYjIyZSIvPjxwYXRoIGQ9Im0wIDE1NTMuMmMtLjEgMTM1LjMgMTA5LjUgMjQ1LjEgMjQ0LjggMjQ1LjIgMTM1LjMtLjEgMjQ0LjktMTA5LjkgMjQ0LjgtMjQ1LjJ2LTI0NS4yaC0yNDQuOGMtMTM1LjMuMS0yNDQuOSAxMDkuOS0yNDQuOCAyNDUuMnptNjUyLjcgMHY2NTRjLS4yIDEzNS4zIDEwOS40IDI0NS4xIDI0NC43IDI0NS4zIDEzNS4zLS4xIDI0NC45LTEwOS45IDI0NC44LTI0NS4ydi02NTMuOWMuMi0xMzUuMy0xMDkuNC0yNDUuMS0yNDQuNy0yNDUuMy0xMzUuNCAwLTI0NC45IDEwOS44LTI0NC44IDI0NS4xIDAgMCAwIC4xIDAgMCIgZmlsbD0iI2UwMWU1YSIvPjwvZz48L3N2Zz4=";

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
    stream?.emit({ type: "data-tool-progress", data: { toolName: "Slack", content: `Planning` } });

    const planResult = await generateObject({
      model: registry.languageModel("anthropic:claude-haiku-4-5"),
      messages: [
        {
          role: "system",
          content: planSystem,
          providerOptions: getDefaultProviderOpts("anthropic"),
        },
        { role: "user", content: prompt },
      ],
      abortSignal,
      schema: planSchema,
      temperature: 0,
      maxOutputTokens: 2000,
      experimental_repairText: repairJson,
    });

    logger.debug("AI SDK generateObject completed", {
      agent: "slack",
      step: "plan-execution",
      usage: planResult.usage,
    });

    const plan = planResult.object;
    logger.debug("slack-communicator plan", { plan });

    // Check for a message or artifacts and format them if they are available
    if (plan.artifactIds) {
      // Summarizing
      stream?.emit({
        type: "data-tool-progress",
        data: { toolName: "Slack", content: "Formatting summary" },
      });

      // Summarization: stringify the first-pass result and refine into a final Slack-ready summary
      const translatePrompt = `Read the provided artifact ids and create a Slack mrkdwn compatible artifact, then return the new artifact id. Use the following ids: ${JSON.stringify(plan.artifactIds)}`;

      const translateResult = await generateText({
        model: registry.languageModel("anthropic:claude-haiku-4-5"),
        abortSignal,
        messages: [
          {
            role: "system",
            content: translateSystem,
            providerOptions: getDefaultProviderOpts("anthropic"),
          },
          { role: "user", content: translatePrompt },
        ],
        tools,
        maxOutputTokens: 2000,
        providerOptions: { anthropic: { thinking: { type: "enabled", budgetTokens: 12000 } } },
        stopWhen: stepCountIs(10),
      });

      logger.debug("AI SDK generateText completed", {
        agent: "slack",
        step: "translate-artifacts",
        usage: translateResult.usage,
      });

      const { steps, toolCalls, toolResults, text, finishReason } = translateResult;

      const { assembledToolResults } = collectToolUsageFromSteps({ steps, toolCalls, toolResults });

      artifactRefs = extractArtifactRefsFromToolResults(assembledToolResults);

      if (artifactRefs && artifactRefs.length > 0) {
        stream?.emit({
          type: "data-outline-update",
          data: {
            id: "slack-translated-summary",
            title: "Formatted Summary",
            icon,
            timestamp: Date.now(),
            artifactId: artifactRefs?.[0]?.id,
            artifactLabel: "View Summary",
          },
        });
      }

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
      data: { toolName: "Slack", content: `Connecting` },
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

      const executionResult = await generateText({
        model: registry.languageModel("anthropic:claude-haiku-4-5"),
        abortSignal,
        messages: [
          {
            role: "system",
            content: executorSystem,
            providerOptions: getDefaultProviderOpts("anthropic"),
          },
          { role: "user", content: executorInstructions },
        ],
        tools,
        toolChoice: "auto",
        stopWhen: stepCountIs(10),
        maxOutputTokens: 800,
        providerOptions: { anthropic: { thinking: { type: "enabled", budgetTokens: 12000 } } },
      });

      stream?.emit({
        type: "data-outline-update",
        data: {
          id: "slack-execution-result",
          title: "Message sent",
          icon,
          timestamp: Date.now(),
          content: executionResult.text,
        },
      });

      logger.debug("AI SDK generateText completed", {
        agent: "slack",
        step: "execute-slack-actions",
        usage: executionResult.usage,
      });

      return { response: executionResult.text, artifactRefs };
    } catch (error) {
      logger.error("slack-communicator failed", { error });
      throw error;
    }
  },
});
