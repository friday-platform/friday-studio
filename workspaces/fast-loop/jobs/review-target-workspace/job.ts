import type { MemoryAdapter } from "@atlas/agent-sdk";
import type { FindingEntry, ReviewJobInput } from "./finding.ts";
import { ReviewJobInputSchema } from "./finding.ts";
import { runReview } from "./reviewer-agent.ts";
import { readRecentSessions } from "./session-reader.ts";

export interface ReviewJobDeps {
  memoryAdapter: MemoryAdapter;
}

export interface ReviewJobResult {
  appendedCount: number;
  findings: FindingEntry[];
}

export async function runReviewJob(
  deps: ReviewJobDeps,
  rawInput: unknown,
): Promise<ReviewJobResult> {
  const input: ReviewJobInput = ReviewJobInputSchema.parse(rawInput);
  const { memoryAdapter } = deps;
  const { targetWorkspaceId, sessionLimit } = input;

  const sessions = await readRecentSessions(memoryAdapter, targetWorkspaceId, {
    limit: sessionLimit,
  });

  const findings = await runReview({ memoryAdapter, targetWorkspaceId }, { sessions });

  return { appendedCount: findings.length, findings };
}
