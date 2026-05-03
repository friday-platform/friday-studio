import process from "node:process";
import { APICallError } from "@ai-sdk/provider";
import type { AtlasAgent, LinkCredentialRef } from "@atlas/agent-sdk";
import { createAgent, err, ok, repairToolCall } from "@atlas/agent-sdk";
import {
  collectToolUsageFromSteps,
  extractArtifactRefsFromToolResults,
} from "@atlas/agent-sdk/vercel-helpers";
import type { LLMAgentConfig } from "@atlas/config";
import {
  getDefaultProviderOpts,
  registry,
  temporalGroundingMessage,
  traceModel,
  validateProvider,
} from "@atlas/llm";
import type { Logger } from "@atlas/logger";
import { stepCountIs, streamText } from "ai";
import { z } from "zod";
import { throwWithCause } from "../utils/error-helpers.ts";
import { filterWorkspaceAgentTools } from "./agent-tool-filters.ts";

/**
 * Default output schema for LLM agents.
 * Text response wrapped as `{ response: string }` for consistent extraction.
 */
export const LLMOutputSchema = z.object({ response: z.string().describe("LLM text response") });
export type LLMOutput = z.infer<typeof LLMOutputSchema>;

/**
 * Convert workspace LLM config to AtlasAgent.
 * Creates a runnable agent using workspace.yml LLM settings.
 *
 * Handler returns AgentPayload via ok()/err() helpers.
 * Execution layer wraps with metadata (agentId, timestamp, input, durationMs).
 */
export function convertLLMToAgent(
  config: LLMAgentConfig,
  agentId: string,
  logger: Logger,
): AtlasAgent<string, LLMOutput> {
  // Use configured retries or default to 3 for better resilience against 529 errors
  const maxRetries = config.config.max_retries ?? 3;

  const provider = validateProvider(config.config.provider);
  const model = traceModel(registry.languageModel(`${provider}:${config.config.model}`));

  const agent = createAgent<string, LLMOutput>({
    id: agentId,
    version: "1.0.0",
    description: config.description,
    outputSchema: LLMOutputSchema,
    expertise: { examples: [] },
    useWorkspaceSkills: true,
    handler: async (prompt, { tools, stream, abortSignal }) => {
      try {
        // Use agent's system prompt directly - no attribution protocol injection
        const systemPrompt = config.config.prompt || "";

        stream?.emit({
          type: "data-tool-progress",
          data: { toolName: agentId, content: "Warming up" },
        });

        // Filter tools based on workspace defaults (apply deny list to remove management tools)
        // Tools are provided via execution context from workspace-level MCP servers
        const filteredTools = filterWorkspaceAgentTools(tools, logger);

        const result = streamText({
          model,
          // role:"system" in messages (rather than the `system:` parameter)
          // because we need providerOptions on it (Anthropic cache-control).
          // The system entry comes from workspace.yml — never user input —
          // so the AI SDK injection warning is a false positive here.
          allowSystemInMessages: true,
          messages: [
            {
              role: "system",
              content: systemPrompt,
              providerOptions: getDefaultProviderOpts(provider),
            },
            temporalGroundingMessage(),
            { role: "user", content: prompt },
          ],
          tools: filteredTools,
          toolChoice: config.config.tool_choice || "auto",
          temperature: config.config.temperature,
          maxOutputTokens: config.config.max_tokens,
          maxRetries,
          stopWhen: stepCountIs(config.config.max_steps || 10),
          abortSignal,
          experimental_repairToolCall: repairToolCall,
          ...(config.config.provider_options || {}),
        });

        stream?.emit({
          type: "data-tool-progress",
          data: { toolName: agentId, content: "Creating results" },
        });

        // NOTE: In current state its just printing whole output in the chat
        // pipeUIMessageStream(result.toUIMessageStream<AtlasUIMessage>(), stream);

        const [text, reasoning, toolCalls, toolResults, steps, usage] = await Promise.all([
          result.text,
          result.reasoningText,
          result.toolCalls,
          result.toolResults,
          result.steps,
          result.usage,
        ]);

        logger.debug("AI SDK generateObject completed", {
          agent: "from-llm-converter",
          step: "llm-agent-execution",
          usage,
        });

        const { assembledToolCalls, assembledToolResults } = collectToolUsageFromSteps({
          steps,
          toolCalls,
          toolResults,
        });

        const artifactRefs = extractArtifactRefsFromToolResults(assembledToolResults, logger);

        return ok(
          { response: text },
          {
            reasoning: reasoning || undefined,
            toolCalls: assembledToolCalls,
            toolResults: assembledToolResults,
            artifactRefs,
          },
        );
      } catch (error) {
        // Simply check if we were aborted, don't try to detect from error
        if (abortSignal?.aborted) {
          logger.info("LLM agent execution cancelled", { agentId });
          stream?.emit({
            type: "data-tool-progress",
            data: { toolName: agentId, content: "Cancelling" },
          });
          // Return error payload for cancellation instead of throwing
          return err("Agent execution cancelled");
        }

        // Enhanced error logging for API overload situations
        const isAPIError = error instanceof APICallError;
        const errorDetails = {
          agentId,
          error,
          errorType: error instanceof Error ? error.name : "Unknown",
          errorMessage: error instanceof Error ? error.message : String(error),
          statusCode: isAPIError ? error.statusCode : undefined,
          isRetryable: isAPIError ? error.isRetryable : false,
          // Specific handling for 529 Overloaded errors
          isOverloaded:
            (isAPIError && error.statusCode === 529) ||
            (error instanceof Error && error.message.includes("Overloaded")),
        };

        logger.error("Error when invoking LLM agent", errorDetails);

        // Log guidance for overload errors
        if (errorDetails.isOverloaded) {
          logger.warn(
            `API overload detected for agent ${agentId}. The SDK will automatically retry up to ${maxRetries} times with exponential backoff.
            Consider:
            1. Adjusting max_retries in agent config (currently ${maxRetries})
            2. Monitoring API status at status.anthropic.com
            3. Implementing rate limiting if this persists`,
          );
        }

        // 529 errors are retried by the AI SDK - throw to let retry logic work
        if (isAPIError && error.statusCode === 529) {
          throwWithCause("API is overloaded. The service will automatically retry.", {
            type: "api",
            code: "OVERLOADED_ERROR",
            statusCode: 529,
          });
        }

        // For other errors, return error payload
        const reason = error instanceof Error ? error.message : String(error);
        return err(reason);
      }
    },
  });

  return agent;
}

/**
 * Create a wrapper agent for type:atlas agent configurations.
 * Wraps a bundled agent with custom prompt and environment variables.
 *
 * Note: Link credential refs in customEnv are filtered out - they should be
 * resolved by the agent credential enricher before reaching this function.
 */
export function wrapAtlasAgent(
  baseAgent: AtlasAgent,
  wrapperId: string,
  customPrompt: string,
  customEnv?: Record<string, string | LinkCredentialRef>,
  description?: string,
  logger?: Logger,
): AtlasAgent<string, unknown> {
  // Resolve env values: "from_environment" reads from process.env,
  // plain strings pass through, Link credential refs are skipped
  // (resolved by the agent credential enricher at execution time)
  const resolvedEnv: Record<string, string> = {};
  if (customEnv) {
    for (const [key, value] of Object.entries(customEnv)) {
      if (typeof value === "string") {
        if (value === "from_environment" || value === "auto") {
          const envValue = process.env[key];
          if (envValue) {
            resolvedEnv[key] = envValue;
          } else {
            logger?.warn(`Environment variable '${key}' not found (from_environment)`, {
              wrapperId,
            });
          }
        } else {
          resolvedEnv[key] = value;
        }
      }
    }
  }

  return createAgent({
    id: wrapperId,
    version: baseAgent.metadata.version,
    description: description || baseAgent.metadata.description,
    expertise: baseAgent.metadata.expertise,
    environment: baseAgent.environmentConfig,
    useWorkspaceSkills: baseAgent.useWorkspaceSkills,
    handler: async (prompt, context) => {
      // Merge resolved env with context env
      const mergedContext = { ...context, env: { ...context.env, ...resolvedEnv } };

      // Prepend custom prompt to user prompt
      const enrichedPrompt = `${customPrompt}\n\n${prompt}`;

      logger?.debug("Wrapped agent executing with custom prompt and env", {
        wrapperId,
        baseAgentId: baseAgent.metadata.id,
        hasCustomEnv: !!customEnv,
      });

      // Delegate to base agent
      return await baseAgent.execute(enrichedPrompt, mergedContext);
    },
  });
}
