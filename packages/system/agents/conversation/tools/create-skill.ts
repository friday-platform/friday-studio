import { client, parseResult } from "@atlas/client/v2";
import { createLogger } from "@atlas/logger";
import { CreateSkillInputSchema, SkillStorage } from "@atlas/skills";
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
    // 1. Load the draft artifact by ID
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

    // 2. Validate it's a skill-draft type
    if (artifact.type !== "skill-draft") {
      logger.error("Artifact is not a skill draft", { artifactId, type: artifact.type });
      return {
        success: false,
        error: `Artifact ${artifactId} is type '${artifact.type}', not 'skill-draft'. Only skill drafts can be promoted.`,
      };
    }

    // 3. Parse and validate the skill input
    const parseResult_ = CreateSkillInputSchema.safeParse(artifact.data.data);
    if (!parseResult_.success) {
      logger.error("Invalid skill draft data", { artifactId, issues: parseResult_.error.issues });
      return {
        success: false,
        error: `Invalid skill draft data: ${parseResult_.error.issues.map((e) => e.message).join(", ")}`,
      };
    }

    const skillInput = parseResult_.data;

    // 4. Create the skill in storage
    const createResult = await SkillStorage.create(createdBy, skillInput);

    if (!createResult.ok) {
      logger.error("Failed to create skill", { artifactId, error: createResult.error });
      return { success: false, error: `Failed to create skill: ${createResult.error}` };
    }

    const skill = createResult.data;

    // 5. Log and return the result
    logger.info("Skill created from draft", {
      skillId: skill.id,
      skillName: skill.name,
      artifactId,
      createdBy,
    });

    return {
      success: true,
      skill: {
        id: skill.id,
        name: skill.name,
        description: skill.description,
        workspaceId: skill.workspaceId,
        createdAt: skill.createdAt.toISOString(),
      },
    };
  },
});
