import { z } from "zod";
import {
  ImprovementFindingBodySchema,
  ScratchpadChunkSchema,
  type ApplyAction,
  type ImprovementFinding,
  type WorkspaceGroup,
} from "./types.ts";

const PROXY_BASE = "/api/daemon";

function sessionKey(workspaceId: string): string {
  return `improvement-inbox::${workspaceId}`;
}

export async function fetchImprovementFindings(
  workspaceIds: string[],
): Promise<ImprovementFinding[]> {
  const results: ImprovementFinding[] = [];

  for (const wsId of workspaceIds) {
    try {
      const res = await globalThis.fetch(
        `${PROXY_BASE}/api/scratchpad/${encodeURIComponent(sessionKey(wsId))}`,
      );
      if (!res.ok) continue;

      const data: unknown = await res.json();
      const chunks = z.array(ScratchpadChunkSchema).safeParse(data);
      if (!chunks.success) continue;

      for (const chunk of chunks.data) {
        const bodyParsed = safeParseBody(chunk.body);
        if (!bodyParsed) continue;
        results.push({ chunk, body: bodyParsed, workspaceId: wsId });
      }
    } catch {
      continue;
    }
  }

  return results;
}

function safeParseBody(raw: string): z.infer<typeof ImprovementFindingBodySchema> | undefined {
  try {
    const json: unknown = JSON.parse(raw);
    const parsed = ImprovementFindingBodySchema.safeParse(json);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function groupFindings(findings: ImprovementFinding[]): WorkspaceGroup[] {
  const wsMap = new Map<string, Map<string, ImprovementFinding[]>>();

  for (const finding of findings) {
    let jobMap = wsMap.get(finding.workspaceId);
    if (!jobMap) {
      jobMap = new Map();
      wsMap.set(finding.workspaceId, jobMap);
    }
    const jobId = finding.body.target_job_id;
    let list = jobMap.get(jobId);
    if (!list) {
      list = [];
      jobMap.set(jobId, list);
    }
    list.push(finding);
  }

  const groups: WorkspaceGroup[] = [];
  for (const [workspaceId, jobMap] of wsMap) {
    const jobs = Array.from(jobMap.entries()).map(([jobId, items]) => ({
      workspaceId,
      jobId,
      findings: items,
    }));
    groups.push({ workspaceId, jobs });
  }

  return groups;
}

export async function applyAction(
  action: ApplyAction,
  finding: ImprovementFinding,
): Promise<void> {
  const key = sessionKey(finding.workspaceId);

  if (action === "dismiss") {
    await clearChunk(key, finding.chunk.id);
    return;
  }

  const res = await globalThis.fetch(`${PROXY_BASE}/api/daemon/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspaceId: finding.workspaceId,
      jobId: finding.body.target_job_id,
      finding: finding.body,
      action,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Apply ${action} failed: ${res.status} ${text}`);
  }

  if (action === "accept") {
    await promoteChunk(key, finding.chunk.id, finding.workspaceId);
  }

  await clearChunk(key, finding.chunk.id);
}

async function promoteChunk(
  key: string,
  chunkId: string,
  workspaceId: string,
): Promise<void> {
  await globalThis.fetch(`${PROXY_BASE}/api/scratchpad/${encodeURIComponent(key)}/promote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chunkId,
      target: { workspaceId, corpus: "notes" },
    }),
  });
}

async function clearChunk(key: string, chunkId: string): Promise<void> {
  await globalThis.fetch(
    `${PROXY_BASE}/api/scratchpad/${encodeURIComponent(key)}/chunks/${encodeURIComponent(chunkId)}`,
    { method: "DELETE" },
  );
}
