import { client, parseResult } from "@atlas/client/v2";
import { SkillDraftSchema } from "@atlas/core/artifacts";
import { createLogger } from "@atlas/logger";
import { SkillStorage } from "@atlas/skills";
import { tool } from "ai";
import { z } from "zod";

const logger = createLogger({ name: "create-skill" });

export const createSkillTool = tool({
  description:
    "Promote an approved skill draft artifact to permanent skill storage. Only use artifact IDs from tool responses. Never invent IDs.",
  inputSchema: z.object({
    artifactId: z.string().describe("Skill draft artifact ID from a tool response"),
    createdBy: z.string().describe("User ID who approved this skill"),
  }),
  execute: async ({ artifactId, createdBy }) => {
    const result = await parseResult(
      client.artifactsStorage[":id"].$get({ param: { id: artifactId }, query: {} }),
    );

    if (!result.ok) {
      logger.error("Artifact not found", { artifactId, error: result.error });
      return {
        success: false,
        error: `Artifact not found: ${artifactId}. Check the ID of the artifact you tried to promote.`,
      };
    }

    const artifact = result.data.artifact;

    if (artifact.type !== "skill-draft") {
      logger.error("Artifact is not a skill draft", { artifactId, type: artifact.type });
      return {
        success: false,
        error: `Artifact ${artifactId} is type '${artifact.type}', not 'skill-draft'. Only skill drafts can be promoted.`,
      };
    }

    const parseResult_ = SkillDraftSchema.safeParse(artifact.data.data);
    if (!parseResult_.success) {
      logger.error("Invalid skill draft data", { artifactId, issues: parseResult_.error.issues });
      return {
        success: false,
        error: `Invalid skill draft data: ${parseResult_.error.issues.map((e) => e.message).join(", ")}`,
      };
    }

    const draft = parseResult_.data;

    // TODO: draft.namespace defaults to "atlas" — read defaultNamespace from workspace config
    // to isolate agent-created skills per workspace when multi-tenant support arrives.
    const publishResult = await SkillStorage.publish(draft.namespace, draft.name, createdBy, {
      description: draft.description,
      instructions: draft.instructions,
    });

    if (!publishResult.ok) {
      logger.error("Failed to publish skill", { artifactId, error: publishResult.error });
      return { success: false, error: `Failed to publish skill: ${publishResult.error}` };
    }

    const { id, version } = publishResult.data;

    logger.info("Skill published from draft", {
      skillId: id,
      namespace: draft.namespace,
      name: draft.name,
      version,
      artifactId,
      createdBy,
    });

    return {
      success: true,
      skill: {
        id,
        namespace: draft.namespace,
        name: draft.name,
        version,
        description: draft.description,
      },
    };
  },
});
