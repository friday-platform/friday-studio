import process from "node:process";
import type {
  KVCorpus,
  MemoryAdapter,
  NarrativeCorpus,
  NarrativeEntry,
  ScratchpadAdapter,
  ScratchpadChunk,
} from "@atlas/agent-sdk";
import { appendDiscoveryAsTask } from "../../../../packages/memory/src/discovery-to-task.ts";
import { reviewWorkspace } from "./reviewer-agent.ts";
import type { ReviewFinding } from "./types.ts";
import { ReviewJobConfigSchema, ReviewSignalPayloadSchema } from "./types.ts";

const SEVERITY_RANK: Record<string, number> = { low: 0, medium: 1, high: 2 };

function severityAtLeast(severity: string, threshold: string): boolean {
  return (SEVERITY_RANK[severity] ?? 0) >= (SEVERITY_RANK[threshold] ?? 0);
}

export interface ReviewJobDeps {
  memoryAdapter: MemoryAdapter;
  scratchpadAdapter: ScratchpadAdapter;
}

export interface ReviewJobResult {
  appendedCount: number;
  findings: ReviewFinding[];
}

export async function runReviewJob(
  deps: ReviewJobDeps,
  signalPayload?: unknown,
): Promise<ReviewJobResult> {
  const { memoryAdapter, scratchpadAdapter } = deps;

  const payload = signalPayload ? ReviewSignalPayloadSchema.parse(signalPayload) : undefined;

  const envTargetId = process.env["REVIEW_TARGET_WORKSPACE_ID"] ?? "";
  const targetWorkspaceId = payload?.targetWorkspaceId ?? envTargetId;
  if (!targetWorkspaceId) {
    throw new Error(
      "Missing targetWorkspaceId: set via signal payload or REVIEW_TARGET_WORKSPACE_ID env var",
    );
  }

  const config = ReviewJobConfigSchema.parse({
    targetWorkspaceId,
    sessionLimit: payload?.sessionLimit,
  });

  const sessions: NarrativeCorpus = await memoryAdapter.corpus(
    config.targetWorkspaceId,
    "sessions",
    "narrative",
  );
  const entries: NarrativeEntry[] = await sessions.read({ limit: config.sessionLimit });

  const kv: KVCorpus = await memoryAdapter.corpus(config.targetWorkspaceId, "config", "kv");
  const workspaceYml = await kv.get<string>("workspace.yml");

  const findings = reviewWorkspace(entries, workspaceYml ?? "");

  const sessionKey = `review-${config.targetWorkspaceId}-${Date.now()}`;
  for (const finding of findings) {
    const chunk: ScratchpadChunk = {
      id: crypto.randomUUID(),
      kind: "review-finding",
      body: JSON.stringify(finding),
      createdAt: new Date().toISOString(),
    };

    await scratchpadAdapter.append(sessionKey, chunk);
    await scratchpadAdapter.promote(sessionKey, chunk.id, {
      workspaceId: config.targetWorkspaceId,
      corpus: config.notesCorpus,
    });
  }

  const improvementPolicy = await kv.get<string>("improvement");
  const policy = improvementPolicy ?? "surface";
  const corpusBaseUrl =
    process.env["CORPUS_BASE_URL"] ??
    "http://localhost:8080/api/memory/thick_endive/narrative/autopilot-backlog";

  for (const finding of findings) {
    if (severityAtLeast(finding.severity, "medium")) {
      await appendDiscoveryAsTask(corpusBaseUrl, {
        discovered_by: "review-target-workspace",
        discovered_session: sessionKey,
        target_workspace_id: config.targetWorkspaceId,
        target_signal_id: finding.target_job_id ?? finding.kind,
        title: finding.summary,
        brief: finding.detail,
        target_files: [],
        priority: finding.severity === "high" ? 70 : 50,
        kind: finding.kind,
        auto_apply: policy === "auto",
      });
    }
  }

  return { appendedCount: findings.length, findings };
}
