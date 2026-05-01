import type { AtlasTools } from "@atlas/agent-sdk";
import { parseSkillRef, SkillRefSchema } from "@atlas/config";
import type { Logger } from "@atlas/logger";
import { SkillStorage } from "@atlas/skills";
import { tool } from "ai";
import { z } from "zod";

const AssignSkillInput = z.object({
  skillRef: SkillRefSchema.describe(
    "Skill reference in @namespace/skill-name format (e.g. @svelte/core-bestpractices)",
  ),
  workspaceId: z
    .string()
    .optional()
    .describe("Target workspace. Defaults to the current session workspace."),
});

const UnassignSkillInput = z.object({
  skillRef: SkillRefSchema.describe(
    "Skill reference in @namespace/skill-name format (e.g. @svelte/core-bestpractices)",
  ),
  workspaceId: z
    .string()
    .optional()
    .describe("Target workspace. Defaults to the current session workspace."),
});

/**
 * Create the `assign_workspace_skill` tool.
 *
 * Attaches a skill from the global catalog to a workspace so that every agent
 * and job in that workspace sees it in `<available_skills>`. Idempotent.
 *
 * For one-time skill use in the current chat, use `load_skill` instead.
 */
export function createAssignWorkspaceSkillTool(
  defaultWorkspaceId: string,
  logger: Logger,
): AtlasTools {
  return {
    assign_workspace_skill: tool({
      description:
        "Attach a skill from the global catalog to this workspace so that every agent and job " +
        "sees it in <available_skills>. For one-time skill use in the current chat, use " +
        "load_skill instead.",
      inputSchema: AssignSkillInput,
      execute: async ({ skillRef, workspaceId }) => {
        const targetWorkspaceId = workspaceId ?? defaultWorkspaceId;
        logger.info("assign_workspace_skill invoked", { skillRef, workspaceId: targetWorkspaceId });

        let namespace: string;
        let name: string;
        try {
          const parsed = parseSkillRef(skillRef);
          namespace = parsed.namespace;
          name = parsed.name;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn("assign_workspace_skill: invalid skill ref", { skillRef, error: message });
          return { success: false as const, error: `Invalid skill reference: ${message}` };
        }

        const getResult = await SkillStorage.get(namespace, name);
        if (!getResult.ok) {
          logger.warn("assign_workspace_skill: lookup failed", {
            skillRef,
            error: getResult.error,
          });
          return { success: false as const, error: getResult.error };
        }

        if (!getResult.data) {
          logger.warn("assign_workspace_skill: skill not found", { skillRef });
          return {
            success: false as const,
            error: `Skill "${skillRef}" not found in the global catalog.`,
          };
        }

        const assignResult = await SkillStorage.assignSkill(
          getResult.data.skillId,
          targetWorkspaceId,
        );
        if (!assignResult.ok) {
          logger.warn("assign_workspace_skill: assignment failed", {
            skillRef,
            skillId: getResult.data.skillId,
            error: assignResult.error,
          });
          return { success: false as const, error: assignResult.error };
        }

        logger.info("assign_workspace_skill succeeded", { skillRef, workspaceId: targetWorkspaceId });
        return {
          success: true as const,
          skill: { ref: skillRef },
          message: `Skill "${skillRef}" is now attached to workspace "${targetWorkspaceId}".`,
        };
      },
    }),
  };
}

/**
 * Create the `unassign_workspace_skill` tool.
 *
 * Removes a skill from a workspace. After unassignment, the skill will no
 * longer appear in `<available_skills>` for this workspace unless it is globally
 * unassigned (visible to all workspaces). Idempotent.
 */
export function createUnassignWorkspaceSkillTool(
  defaultWorkspaceId: string,
  logger: Logger,
): AtlasTools {
  return {
    unassign_workspace_skill: tool({
      description:
        "Remove a skill from this workspace. After unassignment, the skill will no longer " +
        "appear in <available_skills> for this workspace unless it is globally unassigned.",
      inputSchema: UnassignSkillInput,
      execute: async ({ skillRef, workspaceId }) => {
        const targetWorkspaceId = workspaceId ?? defaultWorkspaceId;
        logger.info("unassign_workspace_skill invoked", { skillRef, workspaceId: targetWorkspaceId });

        let namespace: string;
        let name: string;
        try {
          const parsed = parseSkillRef(skillRef);
          namespace = parsed.namespace;
          name = parsed.name;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn("unassign_workspace_skill: invalid skill ref", { skillRef, error: message });
          return { success: false as const, error: `Invalid skill reference: ${message}` };
        }

        const getResult = await SkillStorage.get(namespace, name);
        if (!getResult.ok) {
          logger.warn("unassign_workspace_skill: lookup failed", {
            skillRef,
            error: getResult.error,
          });
          return { success: false as const, error: getResult.error };
        }

        if (!getResult.data) {
          logger.warn("unassign_workspace_skill: skill not found", { skillRef });
          return {
            success: false as const,
            error: `Skill "${skillRef}" not found in the global catalog.`,
          };
        }

        const unassignResult = await SkillStorage.unassignSkill(
          getResult.data.skillId,
          targetWorkspaceId,
        );
        if (!unassignResult.ok) {
          logger.warn("unassign_workspace_skill: unassignment failed", {
            skillRef,
            skillId: getResult.data.skillId,
            error: unassignResult.error,
          });
          return { success: false as const, error: unassignResult.error };
        }

        logger.info("unassign_workspace_skill succeeded", { skillRef, workspaceId: targetWorkspaceId });
        return {
          success: true as const,
          message: `Skill "${skillRef}" has been removed from workspace "${targetWorkspaceId}".`,
        };
      },
    }),
  };
}
