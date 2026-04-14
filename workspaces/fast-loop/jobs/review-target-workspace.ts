import type { KVCorpus, MemoryAdapter, NarrativeCorpus, NarrativeEntry } from "@atlas/agent-sdk";
import type { ReviewAgentFn } from "../agents/workspace-reviewer.ts";
import {
  type ReviewFinding,
  ReviewFindingSchema,
  type ReviewJobInput,
} from "./review-target-workspace.types.ts";

export interface ReviewJobDeps {
  memoryAdapter: MemoryAdapter;
  reviewAgent: ReviewAgentFn;
}

export async function runReviewJob(
  deps: ReviewJobDeps,
  input: ReviewJobInput,
): Promise<{ appendedCount: number; findings: ReviewFinding[] }> {
  const { memoryAdapter, reviewAgent } = deps;
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

  const findings = await reviewAgent({ sessions: entries, workspaceYml: workspaceYml ?? "" });

  const notes: NarrativeCorpus = await memoryAdapter.corpus(
    targetWorkspaceId,
    "notes",
    "narrative",
  );

  let appendedCount = 0;
  for (const finding of findings) {
    const parsed = ReviewFindingSchema.parse(finding);
    await notes.append({
      id: crypto.randomUUID(),
      text: parsed.text,
      author: "workspace-reviewer",
      createdAt: new Date().toISOString(),
      metadata: {
        kind: "review-finding",
        category: parsed.category,
        severity: parsed.severity,
        target_job_id: parsed.targetJobId ?? null,
      },
    });
    appendedCount++;
  }

  return { appendedCount, findings };
}
