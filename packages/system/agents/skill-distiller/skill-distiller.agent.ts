import { createAgent, err, ok, repairJson } from "@atlas/agent-sdk";
import { client, parseResult } from "@atlas/client/v2";
import type { SkillDraft } from "@atlas/core/artifacts";
import { registry, traceModel } from "@atlas/llm";
import { SkillNameSchema } from "@atlas/skills";
import { stringifyError } from "@atlas/utils";
import { generateObject } from "ai";
import { z } from "zod";
import { SKILL_DISTILLER_PROMPT } from "./prompt.ts";
import {
  type SkillDistillerInput,
  SkillDistillerInputSchema,
  type SkillDistillerOutput,
} from "./types.ts";

const SkillOutputSchema = z.object({
  name: SkillNameSchema.describe("Kebab-case skill identifier"),
  description: z
    .string()
    .min(1)
    .max(1024)
    .describe("1-2 sentences explaining what this skill provides and when to use it"),
  instructions: z
    .string()
    .min(1)
    .describe("Detailed markdown capturing patterns, preferences, and actionable guidance"),
});

export const skillDistillerAgent = createAgent<SkillDistillerInput, SkillDistillerOutput>({
  id: "skill-distiller",
  displayName: "Skill Distiller",
  version: "1.0.0",
  description:
    "Distills corpus material from artifacts into a reusable skill definition. Takes artifact IDs as input, uses LLM to extract patterns and preferences, saves result as a skill-draft artifact.",
  expertise: { examples: [] },
  inputSchema: SkillDistillerInputSchema,
  useWorkspaceSkills: true,

  handler: async (input, { logger, stream, session, abortSignal }) => {
    const namespace = input.namespace ?? "friday";

    logger.info("Starting skill distillation", {
      artifactCount: input.artifactIds.length,
      namespace,
      draftArtifactId: input.draftArtifactId,
    });

    try {
      stream?.emit({
        type: "data-tool-progress",
        data: { toolName: "Skill Distiller", content: "Loading corpus material" },
      });

      const corpusResponse = await parseResult(
        client.artifactsStorage["batch-get"].$post(
          { json: { ids: input.artifactIds } },
          { init: { signal: abortSignal } },
        ),
      );

      if (!corpusResponse.ok) {
        return err(`Failed to load corpus artifacts: ${stringifyError(corpusResponse.error)}`);
      }

      if (corpusResponse.data.artifacts.length === 0) {
        return err("No artifacts found for the provided IDs");
      }

      logger.info("Loaded corpus artifacts", { count: corpusResponse.data.artifacts.length });

      let existingDraft: SkillDraft | null = null;
      if (input.draftArtifactId) {
        stream?.emit({
          type: "data-tool-progress",
          data: { toolName: "Skill Distiller", content: "Loading existing draft" },
        });

        try {
          const draftResponse = await parseResult(
            client.artifactsStorage[":id"].$get(
              { param: { id: input.draftArtifactId } },
              { init: { signal: abortSignal } },
            ),
          );

          if (draftResponse.ok && draftResponse.data.artifact.data.type === "skill-draft") {
            existingDraft = draftResponse.data.artifact.data.data;
            logger.info("Loaded existing draft for revision");
          }
        } catch (error) {
          logger.warn("Failed to load existing draft, proceeding with new draft", { error });
        }
      }

      stream?.emit({
        type: "data-tool-progress",
        data: { toolName: "Skill Distiller", content: "Analyzing patterns and extracting skill" },
      });

      const corpusContent = corpusResponse.data.artifacts
        .map((artifact, idx) => {
          const content =
            artifact.data.type === "file"
              ? `[File: ${artifact.title}]`
              : JSON.stringify(artifact.data.data, null, 2);
          return `## Document ${idx + 1}: ${artifact.title}\n\n${content}`;
        })
        .join("\n\n---\n\n");

      let userPrompt = `Distill the following corpus material into a reusable skill definition.

${input.focus ? `Focus area: ${input.focus}\n` : ""}
${input.name ? `Suggested name: ${input.name}\n` : ""}

## Corpus Material

${corpusContent}`;

      if (existingDraft) {
        userPrompt += `

## Existing Draft (Revise This)

Name: ${existingDraft.name}
Description: ${existingDraft.description}
Instructions:
${existingDraft.instructions}

Update this draft based on the corpus material. Preserve what works, improve what doesn't.`;
      }

      const result = await generateObject({
        model: traceModel(registry.languageModel("anthropic:claude-sonnet-4-6")),
        experimental_repairText: repairJson,
        system: SKILL_DISTILLER_PROMPT,
        prompt: userPrompt,
        schema: SkillOutputSchema,
        maxOutputTokens: 8192,
        maxRetries: 3,
        abortSignal,
      });

      logger.debug("AI SDK generateObject completed", {
        agent: "skill-distiller",
        step: "skill-generation",
        usage: result.usage,
      });

      const skill = result.object;

      stream?.emit({
        type: "data-tool-progress",
        data: { toolName: "Skill Distiller", content: "Saving skill draft" },
      });

      const draftData: SkillDraft = {
        name: skill.name,
        namespace,
        description: skill.description,
        instructions: skill.instructions,
      };

      if (existingDraft && input.draftArtifactId) {
        // Update existing draft
        const updateResponse = await parseResult(
          client.artifactsStorage[":id"].$put({
            param: { id: input.draftArtifactId },
            json: {
              type: "skill-draft",
              data: { type: "skill-draft", version: 1, data: draftData },
              summary: skill.description,
              revisionMessage: input.focus
                ? `Revised with focus: ${input.focus}`
                : "Revised based on feedback",
            },
          }),
        );

        if (!updateResponse.ok) {
          return err(`Failed to update skill draft: ${stringifyError(updateResponse.error)}`);
        }

        logger.info("Updated skill draft artifact", {
          artifactId: updateResponse.data.artifact.id,
          revision: updateResponse.data.artifact.revision,
        });

        return ok({
          draftArtifactId: updateResponse.data.artifact.id,
          revision: updateResponse.data.artifact.revision,
          skill: {
            name: skill.name,
            namespace,
            description: skill.description,
            instructions: skill.instructions,
          },
          nextStep:
            "Review the skill draft and either approve for installation or request revisions.",
        });
      } else {
        // Create new draft
        const createResponse = await parseResult(
          client.artifactsStorage.index.$post({
            json: {
              data: { type: "skill-draft", version: 1, data: draftData },
              title: `Skill: ${skill.name}`,
              summary: skill.description,
              workspaceId: session.workspaceId,
              chatId: session.streamId,
            },
          }),
        );

        if (!createResponse.ok) {
          return err(`Failed to create skill draft: ${stringifyError(createResponse.error)}`);
        }

        logger.info("Created skill draft artifact", {
          artifactId: createResponse.data.artifact.id,
        });

        return ok({
          draftArtifactId: createResponse.data.artifact.id,
          revision: 1,
          skill: {
            name: skill.name,
            namespace,
            description: skill.description,
            instructions: skill.instructions,
          },
          nextStep:
            "Review the skill draft and either approve for installation or request revisions.",
        });
      }
    } catch (error) {
      logger.error("Skill distillation failed", { error });
      return err(stringifyError(error));
    }
  },

  environment: { required: [{ name: "ANTHROPIC_API_KEY", description: "Claude API key" }] },
});
