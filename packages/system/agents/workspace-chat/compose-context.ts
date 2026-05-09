import type { AtlasTools } from "@atlas/agent-sdk";
import type { WorkspaceConfig } from "@atlas/config";
import {
  composeArtifactBlocks,
  composeMemoryBlocks,
} from "@atlas/core/agent-context/compose-blocks";
import type { Logger } from "@atlas/logger";
import type { SkillSummary } from "@atlas/skills";
import { resolveVisibleSkills, SkillStorage } from "@atlas/skills";
import { getBlock2Inputs } from "./block2-cache.ts";
import { formatWorkspaceSection, type WorkspaceDetails } from "./workspace-chat.agent.ts";

// Re-export so existing chat-side imports keep working unchanged.
// The canonical implementation now lives in @atlas/core so the FSM
// engine can consume it without crossing the chat-package layering
// boundary. See `packages/core/src/agent-context/compose-blocks.ts`.
export { composeArtifactBlocks, composeMemoryBlocks };

export interface ComposedForegroundContext {
  workspaceId: string;
  details: WorkspaceDetails;
  config?: WorkspaceConfig;
  skills: SkillSummary[];
}

export async function fetchForegroundContexts(
  foregroundIds: string[],
  logger: Logger,
): Promise<ComposedForegroundContext[]> {
  const results = await Promise.allSettled(
    foregroundIds.map(async (workspaceId) => {
      const [block2, skills] = await Promise.all([
        getBlock2Inputs(workspaceId, logger),
        resolveVisibleSkills(workspaceId, SkillStorage),
      ]);

      return { workspaceId, details: block2.details, config: block2.config, skills };
    }),
  );

  const contexts: ComposedForegroundContext[] = [];
  for (const [i, result] of results.entries()) {
    if (result.status === "fulfilled") {
      contexts.push(result.value);
    } else {
      logger.warn("Failed to fetch foreground workspace context", {
        workspaceId: foregroundIds[i],
        error: result.reason,
      });
    }
  }
  return contexts;
}

export function composeWorkspaceSections(
  primarySection: string,
  foregrounds: ComposedForegroundContext[],
): string {
  if (foregrounds.length === 0) return primarySection;

  const sections = [primarySection];
  for (const fg of foregrounds) {
    sections.push(formatWorkspaceSection(fg.workspaceId, fg.details, fg.config));
  }
  return sections.join("\n\n");
}

export function composeSkills(
  primarySkills: SkillSummary[],
  foregrounds: ComposedForegroundContext[],
): SkillSummary[] {
  if (foregrounds.length === 0) return primarySkills;

  const seen = new Set(primarySkills.map((s) => s.skillId));
  const merged = [...primarySkills];

  for (const fg of foregrounds) {
    for (const skill of fg.skills) {
      if (!seen.has(skill.skillId)) {
        seen.add(skill.skillId);
        merged.push(skill);
      }
    }
  }
  return merged;
}

export function composeTools(
  primaryTools: AtlasTools,
  foregroundToolSets: Array<{ workspaceId: string; tools: AtlasTools }>,
): AtlasTools {
  if (foregroundToolSets.length === 0) return primaryTools;

  const merged: AtlasTools = { ...primaryTools };
  for (const { tools } of foregroundToolSets) {
    for (const [name, tool] of Object.entries(tools)) {
      if (!(name in merged)) {
        merged[name] = tool;
      }
    }
  }
  return merged;
}
