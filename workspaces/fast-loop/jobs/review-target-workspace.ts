import type { KVCorpus, MemoryAdapter, NarrativeCorpus, NarrativeEntry } from "@atlas/agent-sdk";
import type { ReviewAgentFn } from "../agents/workspace-reviewer.ts";
import {
  type ReviewFinding,
  type ReviewFindingResult,
  ReviewFindingSchema,
  type ReviewJobInput,
  type ReviewJobResult,
} from "./review-target-workspace.types.ts";

export interface DiscoveryInput {
  discovered_by: string;
  discovered_session: string;
  target_workspace_id: string;
  target_signal_id: string;
  title: string;
  brief: string;
  target_files: string[];
  priority: number;
  kind: string;
  auto_apply: boolean;
}

export type AppendDiscoveryFn = (
  discovery: DiscoveryInput,
) => Promise<{ id: string; createdAt: string }>;

export interface ReviewJobDeps {
  memoryAdapter: MemoryAdapter;
  reviewAgent: ReviewAgentFn;
  appendDiscovery?: AppendDiscoveryFn;
}

const SEVERITY_PRIORITY: Record<string, number> = { error: 70, warn: 50 };

function shouldPromoteToTask(severity: string): boolean {
  return severity === "warn" || severity === "error";
}

export async function runReviewJob(
  deps: ReviewJobDeps,
  input: ReviewJobInput,
): Promise<ReviewJobResult> {
  const { memoryAdapter, reviewAgent, appendDiscovery } = deps;
  const { targetWorkspaceId } = input;
  const sessionLimit = input.sessionLimit ?? 10;

  const sessions: NarrativeCorpus = await memoryAdapter.corpus(
    targetWorkspaceId,
    "sessions",
    "narrative",
  );
  const entries: NarrativeEntry[] = await sessions.read({ limit: sessionLimit });

  const kv: KVCorpus = await memoryAdapter.corpus(targetWorkspaceId, "config", "kv");
  const workspaceYml = await kv.get<string>("workspace.yml");

  const rawFindings = await reviewAgent({ sessions: entries, workspaceYml: workspaceYml ?? "" });

  const notes: NarrativeCorpus = await memoryAdapter.corpus(
    targetWorkspaceId,
    "notes",
    "narrative",
  );

  const ranAt = new Date().toISOString();
  const sessionKey = `review-${targetWorkspaceId}-${Date.now()}`;
  const findingResults: ReviewFindingResult[] = [];

  const improvementRaw = await kv.get<string>("improvement");
  const improvementPolicy = improvementRaw ?? "surface";

  for (const finding of rawFindings) {
    const parsed: ReviewFinding = ReviewFindingSchema.parse(finding);
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();

    await notes.append({
      id,
      text: parsed.summary,
      author: "workspace-reviewer",
      createdAt,
      metadata: {
        kind: "review-finding",
        category: parsed.category,
        severity: parsed.severity,
        target_job_id: parsed.target_job_id ?? null,
      },
    });

    findingResults.push({
      id,
      category: parsed.category,
      severity: parsed.severity,
      summary: parsed.summary,
      detail: parsed.detail,
      target_job_id: parsed.target_job_id ?? null,
      createdAt,
    });

    if (appendDiscovery && shouldPromoteToTask(parsed.severity)) {
      await appendDiscovery({
        discovered_by: "review-target-workspace",
        discovered_session: sessionKey,
        target_workspace_id: targetWorkspaceId,
        target_signal_id: parsed.target_job_id ?? parsed.category,
        title: parsed.summary,
        brief: parsed.detail,
        target_files: [],
        priority: SEVERITY_PRIORITY[parsed.severity] ?? 50,
        kind: parsed.category,
        auto_apply: improvementPolicy === "auto",
      });
    }
  }

  return {
    targetWorkspaceId,
    findings: findingResults,
    appendedCount: findingResults.length,
    ranAt,
  };
}
