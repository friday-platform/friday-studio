import { createAgent, err, ok } from "@atlas/agent-sdk";
import { client, parseResult } from "@atlas/client/v2";
import { registry, traceModel } from "@atlas/llm";
import type { Logger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";
import type { WorkspaceBlueprint } from "@atlas/workspace-builder";
import { buildBlueprint, formatClarifications, PipelineError } from "@atlas/workspace-builder";
import { generateText } from "ai";
import { z } from "zod";

/** Schema for workspace planner success data - exported for use in stop conditions */
export const WorkspacePlannerSuccessDataSchema = z.object({
  planSummary: z.string(),
  artifactId: z.string(),
  revision: z.number(),
  nextStep: z.string(),
});

type WorkspacePlannerSuccessData = z.infer<typeof WorkspacePlannerSuccessDataSchema>;

const WorkspacePlannerInputSchema = z.object({
  intent: z.string().describe("Workspace requirements or modification request"),
  artifactId: z.string().optional().describe("Artifact ID to update (omit for new plans)"),
});

type WorkspacePlannerInput = z.infer<typeof WorkspacePlannerInputSchema>;

/**
 * Generates concise summaries via Haiku 4.5 for revision messages and plan summaries.
 */
async function summarize(params: {
  content: string;
  instruction: string;
  logger: Logger;
  abortSignal?: AbortSignal;
}): Promise<string> {
  const result = await generateText({
    model: traceModel(registry.languageModel("anthropic:claude-haiku-4-5")),
    system:
      "You generate concise, accurate summaries. No fluff, no marketing speak. Direct and informative.",
    prompt: `
    ${params.instruction}

    Content:
    ${params.content}`,
    maxOutputTokens: 100,
    maxRetries: 3,
    abortSignal: params.abortSignal,
  });

  params.logger.debug("AI SDK generateText completed", {
    agent: "workspace-planner",
    step: "summarize",
    usage: result.usage,
  });

  return result.text.trim();
}

export const workspacePlannerAgent = createAgent<
  WorkspacePlannerInput,
  WorkspacePlannerSuccessData
>({
  id: "workspace-planner",
  displayName: "Workspace Planner",
  version: "1.0.0",
  description:
    "Call when user requests workspace creation or modification. Analyzes requirements and generates a detailed workspace plan as an artifact. Returns planSummary and artifactId. For modifications, include existing artifactId to create a revision.",
  expertise: { examples: [] },
  inputSchema: WorkspacePlannerInputSchema,

  handler: async (input, { logger, session, abortSignal }) => {
    logger.info("Starting workspace planning", { artifactId: input.artifactId });

    try {
      // Build the prompt — composite for modifications, plain for new plans
      let prompt = input.intent;
      let existingBlueprint: WorkspaceBlueprint | null = null;

      if (input.artifactId) {
        const response = await parseResult(
          client.artifactsStorage[":id"].$get({ param: { id: input.artifactId } }),
        );
        if (response.ok && response.data.artifact.data.type === "workspace-plan") {
          if (response.data.artifact.data.version === 2) {
            existingBlueprint = response.data.artifact.data.data;
          } else if (response.data.artifact.data.version === 1) {
            // v1 artifact — can't modify, needs re-planning from scratch
            return err(
              "This workspace plan uses an older format. Please create a new plan instead of modifying this one.",
            );
          }
          prompt = `Here is an existing workspace plan:\n\n${JSON.stringify(existingBlueprint)}\n\nThe user wants to make the following changes:\n\n${input.intent}`;
        }
      }

      // Run the full planner pipeline
      const result = await buildBlueprint(prompt, { mode: "workspace", logger, abortSignal });

      // Check clarifications — bail if agent classification has issues
      if (result.clarifications.length > 0) {
        const report = formatClarifications(result.clarifications);
        logger.warn("Workspace planning blocked by clarifications", {
          count: result.clarifications.length,
        });
        return err(`Cannot create workspace plan - missing required information:\n\n${report}`);
      }

      // Check unresolved credentials — bail with connect_service message
      if (result.credentials.unresolved.length > 0) {
        const missing = result.credentials.unresolved
          .map((c) => `- ${c.provider}: ${c.reason} (agent field: ${c.field})`)
          .join("\n");
        logger.warn("Workspace planning blocked by unresolved credentials", {
          count: result.credentials.unresolved.length,
        });
        return err(
          `Cannot create workspace plan - missing service connections. Please call connect_service for the following:\n\n${missing}`,
        );
      }

      const blueprint = {
        ...result.blueprint,
        ...(result.credentials.bindings.length > 0 && {
          credentialBindings: result.credentials.bindings,
        }),
      };

      // Save artifact — PUT for revision, POST for new
      if (existingBlueprint && input.artifactId) {
        const revisionMessage = await summarize({
          content: `Old plan:\n${JSON.stringify(existingBlueprint)}\nNew plan:\n${JSON.stringify(blueprint)}`,
          instruction:
            "Summarize what changed between these two workspace plans in 1-2 sentences. Focus on what was added, removed, or modified.",
          logger,
          abortSignal,
        });
        const artifactSummary = await summarize({
          content: JSON.stringify(blueprint),
          instruction:
            "Summarize this workspace plan in 1-2 sentences. Describe what the workspace does and what agents/signals are involved.",
          logger,
          abortSignal,
        });
        const response = await parseResult(
          client.artifactsStorage[":id"].$put({
            param: { id: input.artifactId },
            json: {
              type: "workspace-plan",
              data: { type: "workspace-plan", version: 2, data: blueprint },
              summary: artifactSummary,
              revisionMessage,
            },
          }),
        );
        if (!response.ok) {
          throw new Error(`Failed to update artifact: ${JSON.stringify(response.error)}`);
        }
        return ok({
          planSummary: blueprint.workspace.purpose,
          artifactId: response.data.artifact.id,
          revision: response.data.artifact.revision,
          nextStep:
            "Plan is auto-displayed to user. Present planSummary and wait for approval. On approval, call fsm-workspace-creator with this artifactId. Do NOT call display_artifact or workspace-planner again.",
        });
      }

      const artifactSummary = await summarize({
        content: JSON.stringify(blueprint),
        instruction:
          "Summarize this workspace plan in 1-2 sentences. Describe what the workspace does and what agents/signals are involved.",
        logger,
        abortSignal,
      });
      const response = await parseResult(
        client.artifactsStorage.index.$post({
          json: {
            data: { type: "workspace-plan", version: 2, data: blueprint },
            title: blueprint.workspace.name,
            summary: artifactSummary,
            workspaceId: session.workspaceId,
            chatId: session.streamId,
          },
        }),
      );
      if (!response.ok) {
        throw new Error(`Failed to create artifact: ${JSON.stringify(response.error)}`);
      }
      return ok({
        planSummary: blueprint.workspace.purpose,
        artifactId: response.data.artifact.id,
        revision: 1,
        nextStep:
          "Plan is auto-displayed to user. Present planSummary and wait for approval. On approval, call fsm-workspace-creator with this artifactId. Do NOT call display_artifact or workspace-planner again.",
      });
    } catch (error) {
      if (error instanceof PipelineError) {
        logger.error("Pipeline failed during workspace planning", {
          phase: error.phase,
          cause: error.cause?.message,
        });
        return err(`Workspace planning failed at "${error.phase}" step: ${error.cause?.message}`);
      }
      logger.error("Failed to plan workspace", { error });
      return err(stringifyError(error));
    }
  },

  environment: { required: [{ name: "ANTHROPIC_API_KEY", description: "Claude API key" }] },
});
