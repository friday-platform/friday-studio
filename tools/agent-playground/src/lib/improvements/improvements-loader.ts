import { z } from "zod";
import { fetchNarrativeCorpus, type NarrativeEntry } from "$lib/api/memory.ts";

const PROXY_BASE = "/api/daemon";

export const ImprovementFindingMetaSchema = z.object({
  kind: z.literal("improvement-finding"),
  target_job_id: z.string().optional(),
  improvement_flag: z.enum(["surface", "auto"]).optional(),
  before_yaml: z.string().optional(),
});

export type ImprovementFindingMeta = z.infer<typeof ImprovementFindingMetaSchema>;

export interface ImprovementEntry {
  id: string;
  text: string;
  author: string | undefined;
  createdAt: string;
  workspaceId: string;
  targetJobId: string;
  beforeYaml: string | undefined;
  body: string;
  metadata: Record<string, unknown>;
}

export interface ImprovementGroup {
  workspaceId: string;
  targetJobId: string;
  findings: ImprovementEntry[];
}

const WORKSPACE_GROUP_KEY = "__workspace__";

export async function loadImprovements(
  workspaceIds: string[],
): Promise<ImprovementGroup[]> {
  const allEntries: ImprovementEntry[] = [];

  const settled = await Promise.allSettled(
    workspaceIds.map((wsId) => loadWorkspaceFindings(wsId)),
  );

  for (const result of settled) {
    if (result.status === "fulfilled") {
      allEntries.push(...result.value);
    }
  }

  return groupByWorkspaceAndJob(allEntries);
}

async function loadWorkspaceFindings(
  workspaceId: string,
): Promise<ImprovementEntry[]> {
  let entries: NarrativeEntry[];
  try {
    entries = await fetchNarrativeCorpus(workspaceId, "notes");
  } catch {
    return [];
  }

  const workspaceLevelFlag = await fetchWorkspaceLevelFlag(workspaceId);

  const findings: ImprovementEntry[] = [];
  for (const entry of entries) {
    const meta = ImprovementFindingMetaSchema.safeParse(entry.metadata);
    if (!meta.success) continue;

    const flag = meta.data.improvement_flag ?? workspaceLevelFlag;
    if (flag !== "surface") continue;

    findings.push({
      id: entry.id,
      text: entry.text,
      author: entry.author,
      createdAt: entry.createdAt,
      workspaceId,
      targetJobId: meta.data.target_job_id ?? WORKSPACE_GROUP_KEY,
      beforeYaml: meta.data.before_yaml,
      body: entry.text,
      metadata: entry.metadata ?? {},
    });
  }

  return findings;
}

async function fetchWorkspaceLevelFlag(
  workspaceId: string,
): Promise<string | undefined> {
  try {
    const res = await globalThis.fetch(
      `${PROXY_BASE}/api/memory/${encodeURIComponent(workspaceId)}/kv/config/improvement_flag`,
    );
    if (!res.ok) return undefined;
    const data: unknown = await res.json();
    const parsed = z.object({ value: z.string() }).safeParse(data);
    return parsed.success ? parsed.data.value : undefined;
  } catch {
    return undefined;
  }
}

function groupByWorkspaceAndJob(entries: ImprovementEntry[]): ImprovementGroup[] {
  const map = new Map<string, Map<string, ImprovementEntry[]>>();

  for (const entry of entries) {
    let jobMap = map.get(entry.workspaceId);
    if (!jobMap) {
      jobMap = new Map();
      map.set(entry.workspaceId, jobMap);
    }
    let list = jobMap.get(entry.targetJobId);
    if (!list) {
      list = [];
      jobMap.set(entry.targetJobId, list);
    }
    list.push(entry);
  }

  const groups: ImprovementGroup[] = [];
  for (const [workspaceId, jobMap] of map) {
    for (const [targetJobId, findings] of jobMap) {
      groups.push({ workspaceId, targetJobId, findings });
    }
  }

  return groups.sort((a, b) => {
    const wsCmp = a.workspaceId.localeCompare(b.workspaceId);
    if (wsCmp !== 0) return wsCmp;
    return a.targetJobId.localeCompare(b.targetJobId);
  });
}
