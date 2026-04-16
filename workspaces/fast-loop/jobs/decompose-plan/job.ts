import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { appendDiscoveryAsTask } from "../../../../packages/memory/src/discovery-to-task.ts";
import { checkIntegrity } from "./integrity.ts";
import type { DecomposerResult, IntegrityFinding } from "./schemas.ts";

/**
 * Exported so the `prepare_decompose` inline action can validate that a
 * caller-supplied `plan_path` is absolute before trying to derive a repo
 * root from it. Inline FSM actions run in a Deno worker without direct
 * access to `node:path`, so this tiny helper exists solely to keep the
 * import surface minimal on the worker side.
 */
export function isAbsolutePath(p: string): boolean {
  return isAbsolute(p);
}

/**
 * Walk up the filesystem from the plan file's enclosing directory until
 * we find a `.git` entry, then return that ancestor as the repo root.
 *
 * Handles two layouts:
 *
 *   1. Regular checkout — `.git` is a directory inside the repo root.
 *   2. Git worktree — `.git` is a text file inside the worktree root
 *      that points at the shared object store. `statSync` catches both.
 *
 * Returns `null` if no `.git` ancestor is found between `plan_path` and
 * the filesystem root. The caller's action throws a helpful error in
 * that case and asks the operator to pass `repo_root` explicitly.
 */
// deno-lint-ignore require-await
export async function findRepoRoot(planPath: string): Promise<string | null> {
  let dir = dirname(planPath);
  // Root sentinel — Node's `dirname("/") === "/"` so compare on stability.
  while (true) {
    const gitEntry = join(dir, ".git");
    try {
      statSync(gitEntry);
      return dir;
    } catch {
      // Not found at this level — walk up.
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Thin wrapper over checkIntegrity for inline FSM import.
 * Gives the `integrity_check` inline function a single-module import path.
 */
export function runIntegrityCheck(batch: DecomposerResult, repoRoot: string): IntegrityFinding[] {
  return checkIntegrity(batch, repoRoot);
}

/**
 * Formats integrity findings as markdown for the retry feedback string.
 * Extracted for testability — the inline `retry_decompose` function
 * duplicates this logic (it's a sync action, can't dynamic-import).
 */
export function buildDecomposerFeedback(findings: IntegrityFinding[], retryCount: number): string {
  const lines: string[] = [`## Integrity Violations (retry ${retryCount})`, ""];
  for (const f of findings) {
    const taskRef = f.task_id ? ` (task: ${f.task_id})` : "";
    lines.push(`- **${f.rule}**${taskRef}: ${f.detail}`);
  }
  return lines.join("\n") + "\n";
}

/**
 * Posts the full decomposer batch to the dry-run-decompositions corpus
 * as a single narrative entry with a 24h expiry timestamp.
 * Called by the inline `apply_to_backlog` action when `dry_run: true`.
 */
export async function postDryRunBatch(
  corpusUrl: string,
  batch: DecomposerResult,
  defaultTarget: { workspace_id: string; signal_id: string },
): Promise<{ batch_id: string; task_count: number }> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 86_400_000);

  const entry = {
    text: batch.batch_id,
    metadata: {
      batch_id: batch.batch_id,
      plan_ref: batch.plan_ref,
      default_target: defaultTarget,
      tasks: batch.tasks,
      expires_at: expiresAt.toISOString(),
      created_at: now.toISOString(),
    },
  };

  const resp = await fetch(corpusUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(entry),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Failed to POST dry-run batch ${batch.batch_id}: ${resp.status} ${errText}`);
  }

  return { batch_id: batch.batch_id, task_count: batch.tasks.length };
}

/**
 * Constructs a Discovery and appends it as a diagnostic task to the backlog.
 * Called by the `emit_diagnostic_task` inline FSM function.
 */
export async function emitDiagnosticTask(
  corpusBaseUrl: string,
  sessionId: string,
  findings: IntegrityFinding[],
  batchId: string,
): Promise<{ id: string; createdAt: string }> {
  const summary = findings
    .map((f) => {
      const taskRef = f.task_id ? ` (task: ${f.task_id})` : "";
      return `- **${f.rule}**${taskRef}: ${f.detail}`;
    })
    .join("\n");

  const brief = [
    "## Decomposition Integrity Failures",
    "",
    `**Batch:** ${batchId}`,
    `**Session:** ${sessionId}`,
    "",
    "### Findings",
    "",
    summary,
  ].join("\n");

  return await appendDiscoveryAsTask(corpusBaseUrl, {
    discovered_by: "decompose-plan",
    discovered_session: sessionId,
    target_workspace_id: "salted_granola",
    target_signal_id: "review-decomposition-failure",
    title: "decompose-plan: persistent integrity violations",
    brief,
    target_files: [],
    priority: 40,
    kind: "decomposition-failure",
    auto_apply: false,
  });
}

/**
 * Resolves the plan file SHA — tries git rev-parse first, falls back to sha256 of content.
 * Returns a 6-char hex string.
 */
export async function resolvePlanSha(planPath: string, repoRoot: string): Promise<string> {
  try {
    const stdout = execFileSync("git", ["rev-parse", "HEAD:" + planPath], {
      cwd: repoRoot,
      encoding: "utf-8",
    });
    return stdout.trim().slice(0, 6);
  } catch {
    // git not available or file not tracked — fall through to sha256
  }

  const content = readFileSync(join(repoRoot, planPath), "utf-8");
  const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  const hex = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hex.slice(0, 6);
}

/**
 * Builds a deterministic batch ID from plan path, SHA, and timestamp.
 * Format: `dp-<slugified-plan-basename>-<YYYYMMDDHHMM>-<6-hex-sha>`
 */
export function buildBatchId(planPath: string, sha: string, now: Date): string {
  const name = basename(planPath, ".md");
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const ts = now.toISOString().replace(/[-:T]/g, "").slice(0, 12);
  return `dp-${slug}-${ts}-${sha.slice(0, 6)}`;
}
