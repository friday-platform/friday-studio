import { createAgent, err, ok, repairJson } from "@atlas/agent-sdk";
import { client, parseResult } from "@atlas/client/v2";
import { getDefaultProviderOpts } from "@atlas/llm";
import { stringifyError } from "@atlas/utils";
import type { SystemModelMessage, UserModelMessage } from "ai";
import { generateObject } from "ai";
import { z } from "zod";
import {
  buildOptimizationPrompt,
  SUPERVISOR_SYSTEM_PROMPT,
  type SupervisorInput,
} from "./prompts.ts";

const SupervisorInputSchema = z.object({
  workflowIntent: z
    .string()
    .describe(
      "What this workflow accomplishes - the goal and purpose from workspace.yml job/signal descriptions",
    ),
  agentSystemPrompt: z
    .string()
    .describe("Target agent's system prompt defining its role and capabilities"),
  agentInputSource: z
    .enum(["signal", "previous", "combined"])
    .describe("Where the agent gets its input: signal only, previous results only, or both"),
  signalPayload: z.unknown().describe("The actual input data that triggered this workflow"),
  previousResults: z
    .array(
      z.object({
        agentId: z.string(),
        task: z.string().describe("What this agent was asked to do"),
        output: z.unknown().describe("Full output from the agent"),
        artifactRefs: z
          .array(z.object({ id: z.string(), type: z.string(), summary: z.string() }))
          .optional(),
      }),
    )
    .describe("Results from previous agents in this workflow"),
  tokenBudget: z.object({
    modelLimit: z.number().describe("Maximum tokens the target agent's model supports"),
    defaultBudget: z.number().describe("Default token budget for agent context"),
    currentUsage: z.number().describe("Tokens already used before this agent's context"),
  }),
});

const SupervisorOutputSchema = z.object({
  optimizedContext: z
    .string()
    .describe(
      "The optimized context for the target agent, formatted for maximum clarity and relevance",
    ),
  metadata: z.object({
    tokenEstimate: z.number().describe("Estimated token count of the optimized context"),
    includedSignal: z.boolean().describe("Whether signal/workflow context was included"),
    includedPreviousCount: z
      .number()
      .describe("Number of previous agent results included in context"),
  }),
  reasoning: z.string().describe("Why these context choices were made (2-3 sentences)"),
});

type SupervisorOutput = z.infer<typeof SupervisorOutputSchema>;

export const sessionSupervisorAgent = createAgent<SupervisorInput, SupervisorOutput>({
  id: "session-supervisor",
  displayName: " Session Supervisor",
  version: "1.0.0",
  description:
    "Optimizes context for agent execution based on agent needs and token constraints. Internal platform agent, not exposed to users.",
  expertise: { examples: [] },
  inputSchema: SupervisorInputSchema,
  handler: async (input, { logger, stream, abortSignal, platformModels }) => {
    try {
      stream?.emit({
        type: "data-tool-progress",
        data: { toolName: " Supervisor", content: "Analyzing agent requirements" },
      });

      /**
       * Expand artifacts (latest revisions) if any artifact IDs are present
       *
       * @TODO When agents can accept structured inputs, prefer returning relevant artifact IDs
       * and let the next agent fetch and use them directly. Avoid supervisor-side expansion
       * to minimize token usage and prevent any chance of structural alteration.
       */
      const artifactIds: string[] = [];
      for (const previousResult of input.previousResults || []) {
        for (const ref of previousResult.artifactRefs || []) {
          artifactIds.push(ref.id);
        }
      }

      // These are of type `Artifact` but only the payload is injected
      let expandedArtifacts: unknown[] | undefined;
      if (artifactIds.length > 0) {
        logger.info("Expanding artifact refs for smart supervisor", { count: artifactIds.length });

        try {
          const timeout = AbortSignal.timeout(5000);
          const signal = abortSignal ? AbortSignal.any([abortSignal, timeout]) : timeout;
          const response = await parseResult(
            client.artifactsStorage["batch-get"].$post(
              { json: { ids: artifactIds } },
              { init: { signal } },
            ),
          );
          if (!response.ok) {
            throw new Error(`Failed to fetch artifacts: ${stringifyError(response.error)}`);
          }
          // Inject only the typed artifact payload to avoid metadata bloat
          // Example injected object:
          // { type: "calendar-schedule", version: 1, data: { events: [...], source: "..." } }
          expandedArtifacts = response.data.artifacts.map((a) => a.data);
          logger.info("Expanded artifacts loaded", { count: expandedArtifacts.length });
        } catch (error) {
          logger.warn("Failed to expand artifacts; proceeding without expansions", {
            error: stringifyError(error),
            artifactCount: artifactIds.length,
          });
          expandedArtifacts = undefined;
        }
      }

      const messages: Array<SystemModelMessage | UserModelMessage> = [
        {
          role: "system",
          content: SUPERVISOR_SYSTEM_PROMPT,
          providerOptions: getDefaultProviderOpts("anthropic"),
        },
        { role: "user", content: buildOptimizationPrompt(input, { expandedArtifacts }) },
      ];

      const result = await generateObject({
        model: platformModels.get("conversational"),
        experimental_repairText: repairJson,
        schema: SupervisorOutputSchema,
        // role:"system" in messages so we can attach providerOptions
        // (Anthropic cache-control) to the supervisor prompt. The
        // system entry is a module-level constant — never user input —
        // so the AI SDK injection warning is a false positive here.
        allowSystemInMessages: true,
        messages,
        maxOutputTokens: 16384,
        maxRetries: 3,
        abortSignal,
      });

      logger.debug("AI SDK generateObject completed", {
        agent: "session-supervisor",
        step: "context-optimization",
        usage: result.usage,
      });

      logger.info(" supervisor optimized context", {
        tokenEstimate: result.object.metadata.tokenEstimate,
        includedSignal: result.object.metadata.includedSignal,
        includedPreviousCount: result.object.metadata.includedPreviousCount,
      });

      return ok(result.object);
    } catch (error) {
      logger.error(" supervisor failed to optimize context", { error });
      return err(stringifyError(error));
    }
  },

  environment: { required: [{ name: "ANTHROPIC_API_KEY", description: "Claude API key" }] },
});
