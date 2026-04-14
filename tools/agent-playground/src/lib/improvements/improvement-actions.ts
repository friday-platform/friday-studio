import type { ImprovementFinding } from "./improvement-finding.ts";

const PROXY_BASE = "/api/daemon";

function sessionKeyFor(workspaceId: string): string {
  return `improvement::${workspaceId}`;
}

export async function acceptFinding(finding: ImprovementFinding): Promise<void> {
  const sessionKey = sessionKeyFor(finding.metadata.workspaceId);

  await globalThis.fetch(
    `${PROXY_BASE}/api/scratchpad/${encodeURIComponent(sessionKey)}/promote`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chunkId: finding.id,
        target: { workspaceId: finding.metadata.workspaceId, corpus: "notes" },
      }),
    },
  );

  const res = await globalThis.fetch(`${PROXY_BASE}/api/daemon/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      findingId: finding.id,
      workspaceId: finding.metadata.workspaceId,
      target_job_id: finding.metadata.target_job_id,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Accept failed: ${res.status} ${text}`);
  }
}

export async function rejectFinding(finding: ImprovementFinding): Promise<void> {
  const res = await globalThis.fetch(`${PROXY_BASE}/api/daemon/reject`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      findingId: finding.id,
      workspaceId: finding.metadata.workspaceId,
      target_job_id: finding.metadata.target_job_id,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Reject failed: ${res.status} ${text}`);
  }
}

export async function dismissFinding(finding: ImprovementFinding): Promise<void> {
  const sessionKey = sessionKeyFor(finding.metadata.workspaceId);

  await globalThis.fetch(
    `${PROXY_BASE}/api/memory/${encodeURIComponent(finding.metadata.workspaceId)}/narrative/notes/${encodeURIComponent(finding.id)}`,
    { method: "DELETE" },
  );

  await globalThis.fetch(
    `${PROXY_BASE}/api/scratchpad/${encodeURIComponent(sessionKey)}/chunks/${encodeURIComponent(finding.id)}`,
    { method: "DELETE" },
  );
}
