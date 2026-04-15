import process from "node:process";
import type { MemoryAdapter, NarrativeCorpus } from "@atlas/agent-sdk";
import { z } from "zod";
import { appendDiscoveryAsTask } from "../../../../packages/memory/src/discovery-to-task.ts";
import { validateAgentBuild } from "./validators/agent-build.ts";
import { validateLint } from "./validators/lint.ts";
import { validateTypecheck } from "./validators/typecheck.ts";
import type { ValidationResult } from "./validators/types.ts";
import { validateWorkspaceYml } from "./validators/workspace-yml.ts";

export const PostSessionValidatorInputSchema = z.object({
  sessionId: z.string(),
  changedFiles: z.array(z.string()),
  taskId: z.string(),
  taskBrief: z.string(),
  taskPriority: z.number(),
  workspaceId: z.string(),
  dispatcherWorkspaceId: z.string(),
});

export type PostSessionValidatorInput = z.infer<typeof PostSessionValidatorInputSchema>;

export const ValidatorDiscoverySchema = z.object({
  discovered_by: z.literal("post-session-validator"),
  discovered_session: z.string(),
  target_workspace_id: z.string(),
  target_signal_id: z.literal("run-task"),
  title: z.string(),
  brief: z.string(),
  target_files: z.array(z.string()),
  priority: z.number(),
  kind: z.literal("validator-finding"),
  auto_apply: z.literal(false),
});

export interface PostSessionValidatorDeps {
  memoryAdapter: MemoryAdapter;
}

export interface PostSessionValidatorResult {
  validated: boolean;
  results: ValidationResult[];
  discoveriesAppended: number;
}

function buildDiscoveryBrief(
  result: ValidationResult,
  input: PostSessionValidatorInput,
  targetFiles: string[],
): string {
  return [
    `## Validator Failure: ${result.validator}`,
    "",
    `**Original task:** ${input.taskId}`,
    `**Session:** ${input.sessionId}`,
    `**Workspace:** ${input.workspaceId}`,
    "",
    "### Validator output (truncated to 40 lines)",
    result.evidence.slice(0, 40).join("\n"),
    "",
    "### FIX",
    `Edit ${targetFiles.join(", ")} so that \`${result.validator}\` passes.`,
    "See the validator output above for the specific issue.",
  ].join("\n");
}

export async function runPostSessionValidator(
  deps: PostSessionValidatorDeps,
  signalPayload?: unknown,
): Promise<PostSessionValidatorResult> {
  const input = PostSessionValidatorInputSchema.parse(signalPayload);

  if (input.changedFiles.length === 0) {
    const backlog: NarrativeCorpus = await deps.memoryAdapter.corpus(
      input.dispatcherWorkspaceId,
      "autopilot-backlog",
      "narrative",
    );
    await backlog.append({
      id: crypto.randomUUID(),
      text: `task:${input.taskId}`,
      author: "post-session-validator",
      createdAt: new Date().toISOString(),
      metadata: { validated: true, sessionId: input.sessionId },
    });
    return { validated: true, results: [], discoveriesAppended: 0 };
  }

  const results: ValidationResult[] = [];
  const platformUrl = process.env["PLATFORM_URL"] ?? "http://localhost:8080";

  // VALIDATE — run validators in sequence
  results.push(await validateTypecheck());
  results.push(await validateLint(input.changedFiles));
  results.push(
    await validateWorkspaceYml(input.changedFiles, {
      platformUrl,
      dispatcherWorkspaceId: input.dispatcherWorkspaceId,
    }),
  );
  results.push(await validateAgentBuild(input.changedFiles));

  const failures = results.filter((r) => !r.ok);
  const allPass = failures.length === 0;

  // ROUTE_FAILURES — create discovery tasks for each failure
  const corpusBaseUrl =
    process.env["CORPUS_BASE_URL"] ??
    `${platformUrl}/api/memory/${input.dispatcherWorkspaceId}/narrative/autopilot-backlog`;

  let discoveriesAppended = 0;
  for (const failure of failures) {
    const targetFiles = input.changedFiles;
    const brief = buildDiscoveryBrief(failure, input, targetFiles);
    const firstLine = failure.evidence[0] ?? failure.message;

    await appendDiscoveryAsTask(corpusBaseUrl, {
      discovered_by: "post-session-validator",
      discovered_session: input.sessionId,
      target_workspace_id: input.workspaceId,
      target_signal_id: "run-task",
      title: `${failure.validator}: ${firstLine.slice(0, 80)}`,
      brief,
      target_files: targetFiles,
      priority: Math.min(input.taskPriority + 1, 100),
      kind: "validator-finding",
      auto_apply: false,
    });
    discoveriesAppended++;
  }

  // MARK_OUTCOME — append validated/blocked to autopilot-backlog
  const backlog: NarrativeCorpus = await deps.memoryAdapter.corpus(
    input.dispatcherWorkspaceId,
    "autopilot-backlog",
    "narrative",
  );

  if (allPass) {
    await backlog.append({
      id: crypto.randomUUID(),
      text: `task:${input.taskId}`,
      author: "post-session-validator",
      createdAt: new Date().toISOString(),
      metadata: { validated: true, sessionId: input.sessionId },
    });
  } else {
    await backlog.append({
      id: crypto.randomUUID(),
      text: `task:${input.taskId}`,
      author: "post-session-validator",
      createdAt: new Date().toISOString(),
      metadata: {
        status: "blocked",
        blocked_reason: "validation_failed",
        sessionId: input.sessionId,
        failing_validators: failures.map((r) => r.validator),
      },
    });
  }

  return { validated: allPass, results, discoveriesAppended };
}
