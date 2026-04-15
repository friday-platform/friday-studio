import { z } from "zod";
import { fetchNarrativeCorpus, type NarrativeEntry } from "../api/memory.ts";
import {
  ImprovementTypeSchema,
  LifecycleImprovementSchema,
  type ImprovementType,
} from "./types.ts";

const PROXY_BASE = "/api/daemon";
const BACKLOG_WORKSPACE = "thick_endive";
const BACKLOG_MEMORY = "autopilot-backlog";

export const ImprovementFindingMetaSchema = z.object({
  kind: z.literal("improvement-finding"),
  target_job_id: z.string().optional(),
  improvement_flag: z.enum(["surface", "auto"]).optional(),
  before_yaml: z.string().optional(),
  improvement_type: ImprovementTypeSchema.optional(),
  status: z.string().optional(),
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
  improvementType: ImprovementType | undefined;
  status: string | undefined;
  source: "notes" | "lifecycle";
}

export interface ImprovementGroup {
  workspaceId: string;
  targetJobId: string;
  findings: ImprovementEntry[];
}

const BacklogPayloadSchema = z.object({
  workspace_id: z.string(),
  signal_id: z.string(),
  task_id: z.string(),
  task_brief: z.string(),
  target_files: z.array(z.string()),
});

const BacklogEntryMetaSchema = z.object({
  auto_apply: z.boolean(),
  payload: BacklogPayloadSchema,
});

const WORKSPACE_GROUP_KEY = "__workspace__";

export async function loadImprovements(
  workspaceIds: string[],
): Promise<ImprovementGroup[]> {
  const allEntries: ImprovementEntry[] = [];

  const settled = await Promise.allSettled([
    ...workspaceIds.map((wsId) => loadWorkspaceFindings(wsId)),
    ...workspaceIds.map((wsId) => loadLifecycleFindings(wsId)),
    loadBacklogFindings(),
  ]);

  for (const result of settled) {
    if (result.status === "fulfilled") {
      allEntries.push(...result.value);
    }
  }

  const seen = new Map<string, ImprovementEntry>();
  for (const entry of allEntries) {
    const existing = seen.get(entry.id);
    if (!existing || entry.source === "lifecycle") {
      seen.set(entry.id, entry);
    }
  }

  return groupByWorkspaceAndJob([...seen.values()]);
}

async function loadLifecycleFindings(
  workspaceId: string,
): Promise<ImprovementEntry[]> {
  try {
    const res = await globalThis.fetch(
      `${PROXY_BASE}/api/improvements?workspace=${encodeURIComponent(workspaceId)}&status=pending`,
    );
    if (!res.ok) return [];
    const data: unknown = await res.json();
    const parsed = z.array(LifecycleImprovementSchema).safeParse(data);
    if (!parsed.success) return [];

    return parsed.data.map((item) => ({
      id: item.id,
      text: item.rationale ?? "",
      author: undefined,
      createdAt: item.createdAt,
      workspaceId: item.workspaceId,
      targetJobId: item.target_job_id ?? WORKSPACE_GROUP_KEY,
      beforeYaml: undefined,
      body: item.diff,
      metadata: {},
      improvementType: item.type,
      status: item.status,
      source: "lifecycle" as const,
    }));
  } catch {
    return [];
  }
}

async function loadBacklogFindings(): Promise<ImprovementEntry[]> {
  let entries: NarrativeEntry[];
  try {
    entries = await fetchNarrativeCorpus(BACKLOG_WORKSPACE, BACKLOG_MEMORY);
  } catch {
    return [];
  }

  const findings: ImprovementEntry[] = [];
  for (const entry of entries) {
    const parsed = BacklogEntryMetaSchema.safeParse(entry.metadata);
    if (!parsed.success) continue;
    if (parsed.data.auto_apply !== false) continue;

    findings.push({
      id: entry.id,
      text: entry.text,
      author: entry.author,
      createdAt: entry.createdAt,
      workspaceId: parsed.data.payload.workspace_id,
      targetJobId: parsed.data.payload.signal_id,
      beforeYaml: undefined,
      body: parsed.data.payload.task_brief,
      metadata: entry.metadata ?? {},
      improvementType: undefined,
      status: undefined,
      source: "notes",
    });
  }

  return findings;
}

export async function acceptBacklogEntry(entryId: string): Promise<void> {
  const url = `${PROXY_BASE}/api/memory/${encodeURIComponent(BACKLOG_WORKSPACE)}/narrative/${encodeURIComponent(BACKLOG_MEMORY)}`;
  await globalThis.fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: entryId,
      text: `Accepted: ${entryId}`,
      createdAt: new Date().toISOString(),
      metadata: { auto_apply: true, status: "pending" },
    }),
  });
}

export async function rejectBacklogEntry(entryId: string): Promise<void> {
  const url = `${PROXY_BASE}/api/memory/${encodeURIComponent(BACKLOG_WORKSPACE)}/narrative/${encodeURIComponent(BACKLOG_MEMORY)}`;
  await globalThis.fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: entryId,
      text: `Rejected: ${entryId}`,
      createdAt: new Date().toISOString(),
      metadata: { status: "rejected" },
    }),
  });
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
      improvementType: meta.data.improvement_type,
      status: meta.data.status,
      source: "notes",
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
