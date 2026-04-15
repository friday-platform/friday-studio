import { z } from "zod";
import { fetchNarrativeCorpus, type NarrativeEntry } from "../api/memory.ts";
import {
  ImprovementTypeSchema,
  LifecycleImprovementSchema,
  type FindingGroup,
  type ImprovementEntry,
  type WorkspaceGroup,
} from "./types.ts";

export type { ImprovementEntry } from "./types.ts";

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
  proposed_full_config: z.string().optional(),
});

export type ImprovementFindingMeta = z.infer<typeof ImprovementFindingMetaSchema>;

const BacklogPayloadSchema = z.object({
  workspace_id: z.string(),
  signal_id: z.string(),
  task_id: z.string(),
  task_brief: z.string(),
  target_files: z.array(z.string()),
});

const BacklogEntryMetaSchema = z.object({
  auto_apply: z.boolean(),
  status: z.string().optional(),
  payload: BacklogPayloadSchema,
});

const WORKSPACE_GROUP_KEY = "__workspace__";

export async function loadImprovements(
  workspaceIds: string[],
): Promise<WorkspaceGroup[]> {
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

  return groupByWorkspace([...seen.values()]);
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
      proposedFullConfig: undefined,
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

  // The backlog is append-only, so multiple entries share an id. Dedupe
  // by taking the LATEST entry per id (highest createdAt wins). That's
  // the entry whose `status` reflects current truth.
  const latestById = new Map<string, NarrativeEntry>();
  for (const entry of entries) {
    const prior = latestById.get(entry.id);
    if (!prior || entry.createdAt > prior.createdAt) {
      latestById.set(entry.id, entry);
    }
  }

  const findings: ImprovementEntry[] = [];
  for (const entry of latestById.values()) {
    const parsed = BacklogEntryMetaSchema.safeParse(entry.metadata);
    if (!parsed.success) continue;

    // Only surface entries that are pending AND not auto-applied.
    if (parsed.data.auto_apply !== false) continue;
    const status = parsed.data.status;
    if (status && status !== "pending") continue;

    findings.push({
      id: entry.id,
      text: entry.text,
      author: entry.author,
      createdAt: entry.createdAt,
      workspaceId: parsed.data.payload.workspace_id,
      targetJobId: parsed.data.payload.signal_id,
      beforeYaml: undefined,
      proposedFullConfig: undefined,
      body: parsed.data.payload.task_brief,
      metadata: entry.metadata ?? {},
      improvementType: undefined,
      status,
      source: "backlog",
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

// Notes-sourced findings (improvement-finding entries in a workspace's
// narrative/notes memory) are also append-only. Accept/reject/dismiss
// writes a new entry with the same id and an updated status, preserving
// the rest of the improvement-finding metadata so the loader's status
// filter drops it from the inbox.
async function upsertNotesEntryStatus(
  workspaceId: string,
  entryId: string,
  status: "accepted" | "rejected" | "dismissed",
  original: ImprovementEntry,
): Promise<void> {
  const url = `${PROXY_BASE}/api/memory/${encodeURIComponent(workspaceId)}/narrative/notes`;
  await globalThis.fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: entryId,
      text: original.text,
      author: original.author ?? "workspace-reviewer",
      createdAt: new Date().toISOString(),
      metadata: { ...original.metadata, kind: "improvement-finding", status },
    }),
  });
}

export function acceptNotesEntry(
  workspaceId: string,
  finding: ImprovementEntry,
): Promise<void> {
  return upsertNotesEntryStatus(workspaceId, finding.id, "accepted", finding);
}

export function rejectNotesEntry(
  workspaceId: string,
  finding: ImprovementEntry,
): Promise<void> {
  return upsertNotesEntryStatus(workspaceId, finding.id, "rejected", finding);
}

export function dismissNotesEntry(
  workspaceId: string,
  finding: ImprovementEntry,
): Promise<void> {
  return upsertNotesEntryStatus(workspaceId, finding.id, "dismissed", finding);
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

  // Notes memory is append-only — accept/reject writes a new entry with the
  // same id and an updated status. Dedupe by id (latest createdAt wins) so
  // the UI only sees current truth and handled findings drop out.
  const latestById = new Map<string, NarrativeEntry>();
  for (const entry of entries) {
    const prior = latestById.get(entry.id);
    if (!prior || entry.createdAt > prior.createdAt) {
      latestById.set(entry.id, entry);
    }
  }

  const findings: ImprovementEntry[] = [];
  for (const entry of latestById.values()) {
    const meta = ImprovementFindingMetaSchema.safeParse(entry.metadata);
    if (!meta.success) continue;

    const flag = meta.data.improvement_flag ?? workspaceLevelFlag;
    if (flag !== "surface") continue;

    // Filter out findings already accepted/rejected/dismissed.
    const status = meta.data.status;
    if (status && status !== "pending") continue;

    findings.push({
      id: entry.id,
      text: entry.text,
      author: entry.author,
      createdAt: entry.createdAt,
      workspaceId,
      targetJobId: meta.data.target_job_id ?? WORKSPACE_GROUP_KEY,
      beforeYaml: meta.data.before_yaml,
      proposedFullConfig: meta.data.proposed_full_config,
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

function groupByWorkspace(entries: ImprovementEntry[]): WorkspaceGroup[] {
  const wsMap = new Map<string, Map<string, ImprovementEntry[]>>();

  for (const entry of entries) {
    let jobMap = wsMap.get(entry.workspaceId);
    if (!jobMap) {
      jobMap = new Map();
      wsMap.set(entry.workspaceId, jobMap);
    }
    let list = jobMap.get(entry.targetJobId);
    if (!list) {
      list = [];
      jobMap.set(entry.targetJobId, list);
    }
    list.push(entry);
  }

  const groups: WorkspaceGroup[] = [];
  for (const [workspaceId, jobMap] of wsMap) {
    const jobs: FindingGroup[] = [];
    for (const [targetJobId, findings] of jobMap) {
      jobs.push({ targetJobId, findings });
    }
    jobs.sort((a, b) => a.targetJobId.localeCompare(b.targetJobId));
    groups.push({ workspaceId, jobs });
  }

  return groups.sort((a, b) => a.workspaceId.localeCompare(b.workspaceId));
}
