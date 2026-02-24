import { env } from "node:process";
import {
  type ArtifactRef,
  createAgent,
  err,
  type LinkCredentialRef,
  type OutlineRef,
  ok,
  repairJson,
  repairToolCall,
  type ToolCall,
  type ToolResult,
} from "@atlas/agent-sdk";
import {
  collectToolUsageFromSteps,
  extractArtifactRefsFromToolResults,
} from "@atlas/agent-sdk/vercel-helpers";

import { getDefaultProviderOpts, registry, traceModel } from "@atlas/llm";
import { stringifyError } from "@atlas/utils";
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
export const SlackOutputSchema = z.object({
  response: z.string().describe("Slack execution result text"),
});

type SlackOutput = z.infer<typeof SlackOutputSchema>;

export const slackCommunicatorAgent = createAgent<string, SlackOutput>({
  id: "slack",
  displayName: "Slack",
  version: "1.0.0",
  description:
    "Post messages to Slack channels and DMs via slack-mcp-server. Reads artifacts and formats them as Slack mrkdwn before posting. USE FOR: sending Slack messages, posting artifacts/summaries to channels, channel notifications.",
  constraints:
    "Requires Slack OAuth token. Posts and reads via slack-mcp-server only. Cannot send email — use the email agent or google-gmail MCP server for email.",
  outputSchema: SlackOutputSchema,
  expertise: {
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
        linkRef: { provider: "slack", key: "access_token" },
      },
    ],
  },
  // Provide Slack MCP config here so callers (e.g., orchestrator) can merge and use it
  // with slack-mcp-server using XOXP token via npx.
  mcp: {
    slack: {
      transport: {
        type: "stdio",
        command: "npx",
        args: ["-y", "@tempestteam/slack-mcp-server@latest"],
      },
      env: {
        SLACK_MCP_XOXP_TOKEN: {
          from: "link",
          provider: "slack",
          key: "access_token",
        } satisfies LinkCredentialRef,
        SLACK_MCP_ADD_MESSAGE_TOOL: "true",
      },
      client_config: { timeout: { progressTimeout: "2m", maxTotalTimeout: "30m" } },
    },
  },

  handler: async (prompt, { tools, logger, abortSignal, stream }) => {
    if (!env.ANTHROPIC_API_KEY && !env.LITELLM_API_KEY) {
      return err("ANTHROPIC_API_KEY or LITELLM_API_KEY environment variable is required");
    }

    // Collect all tool calls and results across execution phases
    let allToolCalls: ToolCall[] = [];
    let allToolResults: ToolResult[] = [];
    let artifactRefs: ArtifactRef[] | null = null;

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

    stream?.emit({ type: "data-tool-progress", data: { toolName: "Slack", content: `Planning` } });

    const planResult = await generateObject({
      model: traceModel(registry.languageModel("anthropic:claude-haiku-4-5")),
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

    if (plan.artifactIds) {
      stream?.emit({
        type: "data-tool-progress",
        data: { toolName: "Slack", content: "Formatting summary" },
      });

      const translatePrompt = `Read the provided artifact ids and create a Slack mrkdwn compatible artifact, then return the new artifact id. Use the following ids: ${JSON.stringify(plan.artifactIds)}`;

      const translateResult = await generateText({
        model: traceModel(registry.languageModel("anthropic:claude-haiku-4-5")),
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
        experimental_repairToolCall: repairToolCall,
      });

      logger.debug("AI SDK generateText completed", {
        agent: "slack",
        step: "translate-artifacts",
        usage: translateResult.usage,
      });

      const { assembledToolCalls, assembledToolResults } = collectToolUsageFromSteps({
        steps: translateResult.steps,
        toolCalls: translateResult.toolCalls,
        toolResults: translateResult.toolResults,
      });

      allToolCalls = [...allToolCalls, ...assembledToolCalls];
      allToolResults = [...allToolResults, ...assembledToolResults];
      artifactRefs = extractArtifactRefsFromToolResults(assembledToolResults);

      logger.info("slack-summarizer summary", { text: translateResult.text });

      if (translateResult.finishReason === "error") {
        logger.error("slack-summarizer failed", { error: translateResult.text });

        stream?.emit({
          type: "data-tool-progress",
          data: { toolName: "Slack", content: "Failed to summarize the content" },
        });
      }
    }

    stream?.emit({
      type: "data-tool-progress",
      data: { toolName: "Slack", content: `Connecting` },
    });

    try {
      const executorInstructions = `
        <task>
          ${JSON.stringify(plan.intent)}
        </task>

        <channel>
          ${plan.targetChannel ?? "Not provided"}
        </channel>

        <content>
          <message>
            ${plan.message ?? "Not provided"}
          </message>

          <artifactIds>
            ${artifactRefs ? artifactRefs.map((ref) => ref.id) : "Not provided"}
          </artifactIds>
        </content>

        <additional_context>
          ${plan.additionalContext ?? "Not provided"}
        </additional_context>

        Execute using the available tools to fulfill the intent. If content is present, send both the message and contents of each artifact id to the targetChannel.
      `;

      stream?.emit({
        type: "data-tool-progress",
        data: { toolName: "Slack", content: `Executing: ${plan.intent}` },
      });

      // If no tools are available, do not attempt execution; return a clear message.
      if (!tools || Object.keys(tools).length === 0) {
        return err("Cannot complete: Slack tools unavailable");
      }

      const executionResult = await generateText({
        model: traceModel(registry.languageModel("anthropic:claude-haiku-4-5")),
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
        experimental_repairToolCall: repairToolCall,
      });

      logger.debug("AI SDK generateText completed", {
        agent: "slack",
        step: "execute-slack-actions",
        usage: executionResult.usage,
      });

      const { assembledToolCalls: execToolCalls, assembledToolResults: execToolResults } =
        collectToolUsageFromSteps({
          steps: executionResult.steps,
          toolCalls: executionResult.toolCalls,
          toolResults: executionResult.toolResults,
        });

      allToolCalls = [...allToolCalls, ...execToolCalls];
      allToolResults = [...allToolResults, ...execToolResults];

      const execArtifactRefs = extractArtifactRefsFromToolResults(execToolResults);
      if (execArtifactRefs.length > 0) {
        artifactRefs = [...(artifactRefs ?? []), ...execArtifactRefs];
      }

      const outlineRefs: OutlineRef[] = [];
      if (artifactRefs?.[0]) {
        outlineRefs.push({
          service: "slack",
          title: "Formatted Summary",
          artifactId: artifactRefs[0].id,
          artifactLabel: "View Summary",
        });
      }
      outlineRefs.push({ service: "slack", title: "Message sent", content: executionResult.text });

      return ok(
        { response: executionResult.text },
        {
          toolCalls: allToolCalls,
          toolResults: allToolResults,
          artifactRefs: artifactRefs ?? undefined,
          outlineRefs,
        },
      );
    } catch (error) {
      logger.error("slack-communicator failed", { error });
      return err(stringifyError(error));
    }
  },
});
