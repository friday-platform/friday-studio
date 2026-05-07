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
import { composeValidationBlock } from "../agent-context/compose-blocks.ts";
import {
  createRecordValidationTool,
  RECORD_VALIDATION_TOOL_NAME,
} from "../agent-context/record-validation-tool.ts";
import {
  readValidateDecisionFromConfig,
  type ValidateDecisionContext,
} from "../agent-context/validate-decision.ts";
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
    handler: async (prompt, { tools, stream, abortSignal, config: ctxConfig }) => {
      try {
        // Use agent's system prompt directly - no attribution protocol injection
        let systemPrompt = config.config.prompt || "";

        // B4 (melodic-strolling-seal-pt2): close the case-llm-vs-case-agent
        // validation asymmetry. The FSM engine resolves the validation
        // decision in `case "agent"` and threads it through
        // `AgentExecutorOptions.validateDecision` → workspace runtime →
        // `AgentExecutionContext.config` (under the reserved
        // `__atlas_validate` key) → here. When the decision is `self` we
        // append the bundled `validating-llm-outputs` skill body to the
        // system prompt — same skill, same helper, same placement
        // (after the author-declared base, mirroring `case "llm"`'s
        // ordering after memory + artifact blocks). `skip` and
        // `external` leave the prompt untouched. Failures inside
        // `composeValidationBlock` swallow + log; they never block the
        // agent.
        const validateCtx: ValidateDecisionContext = readValidateDecisionFromConfig(ctxConfig);
        // E1.1 (melodic-strolling-seal-pt3): on the structured + self path,
        // skip the validation skill body — mirrors the `injectRecordValidation`
        // predicate below. The skill body says "you MUST call
        // record_validation"; if we've also suppressed the tool injection
        // (E1, below), the LLM sees contradictory instructions and bails
        // into prose. Skip both for the structured + self case so verdict
        // is implicit pass on successful complete-tool emission.
        const skipValidationSkillBody =
          validateCtx.decision === "self" && validateCtx.hasOutputType === true;
        const validationBlock = skipValidationSkillBody
          ? ""
          : await composeValidationBlock({
              decision: validateCtx.decision,
              skillName: validateCtx.skill,
              logger,
            });
        if (validationBlock) {
          systemPrompt = `${systemPrompt}\n\n${validationBlock}`;
          logger.debug("Injected validation skill block into LLM agent system prompt", {
            agentId,
            decision: validateCtx.decision,
            blockChars: validationBlock.length,
          });
        }

        stream?.emit({
          type: "data-tool-progress",
          data: { toolName: agentId, content: "Warming up" },
        });

        // Filter tools based on workspace defaults (apply deny list to remove management tools)
        // Tools are provided via execution context from workspace-level MCP servers
        const filteredTools = filterWorkspaceAgentTools(tools, logger);

        // B6 (melodic-strolling-seal-pt2): inject the `record_validation`
        // platform tool when the resolved validation decision is `self`. The
        // FSM engine threads the decision in via `__atlas_validate` (B4); the
        // skill body composed above instructs the LLM to call this tool with
        // its inline self-check verdict. The captured args are read off the
        // streamText result's toolCalls back in fsm-engine's `case "agent"`
        // post-execution site so `step:complete.validation` carries them
        // identically to the inline `case "llm"` path.
        //
        // E1 (melodic-strolling-seal-pt2): when the action declares an
        // `outputType:` (structured schema), the orchestrator skips
        // `record_validation` injection. The structured schema IS the
        // validation contract; injecting `record_validation` here forces
        // toolChoice off the forced-complete pin and lets the LLM emit
        // free-form prose instead of structured output. Verdict on the
        // structured + self path is implicit pass on successful structured
        // emission. E1.1 (pt3): the skill body is also skipped on this
        // path — see `skipValidationSkillBody` above for why.
        const injectRecordValidation =
          validateCtx.decision === "self" && !validateCtx.hasOutputType;
        const toolsWithValidation = injectRecordValidation
          ? {
              ...filteredTools,
              [RECORD_VALIDATION_TOOL_NAME]:
                createRecordValidationTool() as (typeof filteredTools)[string],
            }
          : filteredTools;

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
          tools: toolsWithValidation,
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
