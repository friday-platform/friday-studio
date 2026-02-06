import { z } from "zod";

export const SkillDistillerInputSchema = z.object({
  artifactIds: z.array(z.string()).min(1).describe("Artifact IDs containing corpus material"),
  workspaceId: z.string().describe("Target workspace for the skill"),
  name: z.string().optional().describe("Suggested skill name"),
  focus: z.string().optional().describe("What aspect to emphasize"),
  draftArtifactId: z.string().optional().describe("Existing draft to revise"),
});

export type SkillDistillerInput = z.infer<typeof SkillDistillerInputSchema>;

export interface SkillDistillerOutput {
  draftArtifactId: string;
  revision: number;
  skill: { name: string; description: string; instructions: string };
  nextStep: string;
}
