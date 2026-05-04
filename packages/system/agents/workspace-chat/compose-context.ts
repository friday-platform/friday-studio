import type { AtlasTools } from "@atlas/agent-sdk";
import type { WorkspaceConfig } from "@atlas/config";
import type { Logger } from "@atlas/logger";
import { getAtlasDaemonUrl } from "@atlas/oapi-client";
import type { SkillSummary } from "@atlas/skills";
import { resolveVisibleSkills, SkillStorage } from "@atlas/skills";
import { z } from "zod";
import { getBlock2Inputs } from "./block2-cache.ts";
import { formatWorkspaceSection, type WorkspaceDetails } from "./workspace-chat.agent.ts";

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

const MemoryListSchema = z.array(
  z.object({ workspaceId: z.string(), name: z.string(), kind: z.string() }),
);

const NarrativeEntrySchema = z.object({
  id: z.string(),
  text: z.string(),
  author: z.string().optional(),
  createdAt: z.string(),
});

export async function composeMemoryBlocks(
  primaryId: string,
  foregroundIds: string[],
  logger: Logger,
): Promise<string[]> {
  const daemonUrl = getAtlasDaemonUrl();
  const allIds = [primaryId, ...foregroundIds];
  const blocks: string[] = [];

  // Track which (source workspace, store name) pairs have already been emitted
  // so that mounts and explicit foreground IDs pointing to the same store don't
  // produce duplicate blocks.
  const emittedStoreKeys = new Set<string>();

  const results = await Promise.allSettled(
    allIds.map(async (workspaceId) => {
      const listRes = await fetch(`${daemonUrl}/api/memory/${encodeURIComponent(workspaceId)}`);
      if (!listRes.ok) return [];

      const listData = MemoryListSchema.safeParse(await listRes.json());
      if (!listData.success || listData.data.length === 0) return [];

      const narrativeStores = listData.data.filter((m) => m.kind === "narrative");
      if (narrativeStores.length === 0) return [];

      // Group stores by their source workspace. Own stores have
      // store.workspaceId === workspaceId; mounted stores point elsewhere.
      const bySource = new Map<string, z.infer<typeof MemoryListSchema>[number][]>();
      for (const store of narrativeStores) {
        const src = store.workspaceId;
        const existing = bySource.get(src) ?? [];
        existing.push(store);
        bySource.set(src, existing);
      }

      const wsBlocks: string[] = [];
      for (const [sourceId, stores] of bySource) {
        const storeResults = await Promise.allSettled(
          stores.map(async (store) => {
            const key = `${sourceId}:${store.name}`;
            if (emittedStoreKeys.has(key)) return null;
            emittedStoreKeys.add(key);

            const url = `${daemonUrl}/api/memory/${encodeURIComponent(store.workspaceId)}/narrative/${encodeURIComponent(store.name)}?limit=20`;
            const res = await fetch(url);
            if (!res.ok) return null;
            const data = z.array(NarrativeEntrySchema).safeParse(await res.json());
            const entries = data.success ? data.data : [];
            if (entries.length === 0) return null;

            const lines = entries.map((e) => `- ${e.text}`);
            return `<memory workspace="${sourceId}" store="${store.name}">\n${lines.join("\n")}\n</memory>`;
          }),
        );

        for (const r of storeResults) {
          if (r.status === "fulfilled" && r.value !== null) {
            wsBlocks.push(r.value);
          }
        }
      }

      return wsBlocks;
    }),
  );

  for (const [i, result] of results.entries()) {
    if (result.status === "fulfilled") {
      blocks.push(...result.value);
    } else if (result.status === "rejected") {
      logger.warn("Failed to fetch memory for workspace", {
        workspaceId: allIds[i],
        error: result.reason,
      });
    }
  }

  return blocks;
}
