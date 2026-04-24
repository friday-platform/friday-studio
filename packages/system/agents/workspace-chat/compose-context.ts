import type { AtlasTools } from "@atlas/agent-sdk";
import { client, parseResult } from "@atlas/client/v2";
import type { WorkspaceConfig } from "@atlas/config";
import type { Logger } from "@atlas/logger";
import { getAtlasDaemonUrl } from "@atlas/oapi-client";
import type { ResourceEntry } from "@atlas/resources";
import type { SkillSummary } from "@atlas/skills";
import { resolveVisibleSkills, SkillStorage } from "@atlas/skills";
import { z } from "zod";
import {
  fetchWorkspaceDetails,
  formatWorkspaceSection,
  type WorkspaceDetails,
} from "./workspace-chat.agent.ts";

export interface ComposedForegroundContext {
  workspaceId: string;
  details: WorkspaceDetails;
  config?: WorkspaceConfig;
  skills: SkillSummary[];
  resourceEntries: ResourceEntry[];
}

interface ComposedContext {
  workspaceSections: string;
  mergedSkills: SkillSummary[];
  foregroundTools: Record<string, AtlasTools>;
  mergedResources: ResourceEntry[];
  memoryBootstrapBlocks: string[];
}

export async function fetchForegroundContexts(
  foregroundIds: string[],
  logger: Logger,
): Promise<ComposedForegroundContext[]> {
  const results = await Promise.allSettled(
    foregroundIds.map(async (workspaceId) => {
      const [details, wsConfigResult, skills] = await Promise.all([
        fetchWorkspaceDetails(workspaceId, logger),
        parseResult(client.workspace[":workspaceId"].config.$get({ param: { workspaceId } })),
        resolveVisibleSkills(workspaceId, SkillStorage),
      ]);

      const config = wsConfigResult.ok ? wsConfigResult.data.config : undefined;

      return { workspaceId, details, config, skills, resourceEntries: details.resourceEntries };
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

export function composeResources(
  primaryResources: ResourceEntry[],
  foregrounds: ComposedForegroundContext[],
): ResourceEntry[] {
  if (foregrounds.length === 0) return primaryResources;

  const seen = new Set(primaryResources.map((r) => r.slug));
  const merged = [...primaryResources];

  for (const fg of foregrounds) {
    for (const entry of fg.resourceEntries) {
      if (!seen.has(entry.slug)) {
        seen.add(entry.slug);
        merged.push(entry);
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

  // Track which source workspaces have already been emitted so that mounts
  // and explicit foreground IDs pointing to the same workspace don't
  // produce duplicate blocks.
  const emittedSourceIds = new Set<string>();

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
        if (emittedSourceIds.has(sourceId)) continue;
        emittedSourceIds.add(sourceId);

        const entryResults = await Promise.allSettled(
          stores.map(async (store) => {
            const url = `${daemonUrl}/api/memory/${encodeURIComponent(store.workspaceId)}/narrative/${encodeURIComponent(store.name)}?limit=20`;
            const res = await fetch(url);
            if (!res.ok) return [];
            const data = z.array(NarrativeEntrySchema).safeParse(await res.json());
            return data.success ? data.data : [];
          }),
        );

        const entries = entryResults
          .filter(
            (r): r is PromiseFulfilledResult<z.infer<typeof NarrativeEntrySchema>[]> =>
              r.status === "fulfilled",
          )
          .flatMap((r) => r.value);

        if (entries.length === 0) continue;

        const lines = entries.map((e) => `- ${e.text}`);
        wsBlocks.push(`<memory workspace="${sourceId}">\n${lines.join("\n")}\n</memory>`);
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
