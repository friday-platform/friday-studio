import { existsSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import type { DecomposerResult, IntegrityFinding } from "./schemas.ts";

/**
 * Validates a decomposer batch against 5 structural integrity rules.
 * Returns an empty array for valid batches, or one BLOCK finding per violation.
 */
export function checkIntegrity(
  batch: DecomposerResult,
  repoRoot: string = process.cwd(),
): IntegrityFinding[] {
  return [
    ...checkNoCycles(batch.tasks),
    ...checkBlockedByResolves(batch.tasks),
    ...checkNonEmptyContent(batch.tasks),
    ...checkTracerDiscipline(batch.tasks),
    ...checkTargetFilesResolve(batch.tasks, repoRoot),
  ];
}

// --- Rule: no_cycles (Kahn's algorithm) ---

function checkNoCycles(tasks: DecomposerResult["tasks"]): IntegrityFinding[] {
  const taskIds = new Set(tasks.map((t) => t.task_id));
  const taskMap = new Map(tasks.map((t) => [t.task_id, t]));
  const dependents = new Map<string, string[]>();
  const inDegree = new Map<string, number>();

  for (const task of tasks) {
    dependents.set(task.task_id, []);
  }

  for (const task of tasks) {
    let degree = 0;
    for (const dep of task.blocked_by) {
      if (taskIds.has(dep)) {
        const list = dependents.get(dep);
        if (list) list.push(task.task_id);
        degree++;
      }
    }
    inDegree.set(task.task_id, degree);
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  let processed = 0;
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    processed++;
    for (const dep of dependents.get(current) ?? []) {
      const newDeg = (inDegree.get(dep) ?? 0) - 1;
      inDegree.set(dep, newDeg);
      if (newDeg === 0) queue.push(dep);
    }
  }

  if (processed === tasks.length) return [];

  const remaining = new Set<string>();
  for (const [id, deg] of inDegree) {
    if (deg > 0) remaining.add(id);
  }

  const cyclePath = extractCyclePath(remaining, taskMap);
  const detail =
    cyclePath.length > 0
      ? `Cycle detected: ${cyclePath.join(" \u2192 ")}`
      : `Cycle detected among: ${[...remaining].join(", ")}`;

  return [{ rule: "no_cycles", severity: "BLOCK", detail }];
}

function extractCyclePath(
  remaining: Set<string>,
  taskMap: Map<string, DecomposerResult["tasks"][number]>,
): string[] {
  let start: string | undefined;
  for (const id of remaining) {
    start = id;
    break;
  }
  if (start === undefined) return [];

  const path: string[] = [start];
  const seen = new Set<string>([start]);
  let current = start;

  for (;;) {
    const task = taskMap.get(current);
    if (!task) break;

    let next: string | undefined;
    for (const dep of task.blocked_by) {
      if (remaining.has(dep)) {
        next = dep;
        break;
      }
    }
    if (next === undefined) break;

    if (seen.has(next)) {
      const cycleStart = path.indexOf(next);
      return [...path.slice(cycleStart), next];
    }

    path.push(next);
    seen.add(next);
    current = next;
  }

  return path;
}

// --- Rule: blocked_by_resolves ---

function checkBlockedByResolves(tasks: DecomposerResult["tasks"]): IntegrityFinding[] {
  const taskIds = new Set(tasks.map((t) => t.task_id));
  const findings: IntegrityFinding[] = [];

  for (const task of tasks) {
    const dangling = task.blocked_by.filter((id) => !taskIds.has(id));
    if (dangling.length > 0) {
      findings.push({
        rule: "blocked_by_resolves",
        severity: "BLOCK",
        task_id: task.task_id,
        detail: `blocked_by references non-existent task(s): ${dangling.join(", ")}`,
      });
    }
  }

  return findings;
}

// --- Rule: non_empty_content ---

function hasNonEmptySection(brief: string, heading: string): boolean {
  const pattern = new RegExp(`## ${heading}\\s*\\n([\\s\\S]*?)(?=\\n## |$)`);
  const match = pattern.exec(brief);
  if (!match || match[1] === undefined) return false;
  return /\S/.test(match[1]);
}

function checkNonEmptyContent(tasks: DecomposerResult["tasks"]): IntegrityFinding[] {
  const findings: IntegrityFinding[] = [];

  for (const task of tasks) {
    const problems: string[] = [];

    if (task.subject.trim().length === 0) {
      problems.push("empty subject");
    }
    if (!hasNonEmptySection(task.task_brief, "Acceptance Criteria")) {
      problems.push("missing or empty '## Acceptance Criteria' section");
    }
    if (!hasNonEmptySection(task.task_brief, "Starting Points")) {
      problems.push("missing or empty '## Starting Points' section");
    }

    if (problems.length > 0) {
      findings.push({
        rule: "non_empty_content",
        severity: "BLOCK",
        task_id: task.task_id,
        detail: problems.join("; "),
      });
    }
  }

  return findings;
}

// --- Rule: tracer_discipline ---

function checkTracerDiscipline(tasks: DecomposerResult["tasks"]): IntegrityFinding[] {
  if (tasks.length <= 1) return [];

  const tracers = tasks.filter((t) => t.is_tracer);
  const findings: IntegrityFinding[] = [];

  if (tracers.length === 0) {
    findings.push({
      rule: "tracer_discipline",
      severity: "BLOCK",
      detail: "Multi-task batch has no tracer task (exactly one required)",
    });
    return findings;
  }

  if (tracers.length > 1) {
    findings.push({
      rule: "tracer_discipline",
      severity: "BLOCK",
      detail: `Multi-task batch has ${tracers.length} tracer tasks (exactly one required): ${tracers.map((t) => t.task_id).join(", ")}`,
    });
    return findings;
  }

  const tracer = tracers[0];
  if (tracer) {
    if (!tracer.subject.startsWith("Tracer Bullet:")) {
      findings.push({
        rule: "tracer_discipline",
        severity: "BLOCK",
        task_id: tracer.task_id,
        detail: `Tracer task subject must start with "Tracer Bullet:", got: "${tracer.subject}"`,
      });
    }
    if (tracer.blocked_by.length > 0) {
      findings.push({
        rule: "tracer_discipline",
        severity: "BLOCK",
        task_id: tracer.task_id,
        detail: `Tracer task must have empty blocked_by, got: ${tracer.blocked_by.join(", ")}`,
      });
    }
  }

  return findings;
}

// --- Rule: target_files_resolve ---

function checkTargetFilesResolve(
  tasks: DecomposerResult["tasks"],
  repoRoot: string,
): IntegrityFinding[] {
  // Collect paths from tasks whose brief mentions (to-create)
  const toCreateByTask = new Map<string, Set<string>>();
  for (const task of tasks) {
    if (task.task_brief.includes("(to-create)")) {
      toCreateByTask.set(task.task_id, new Set(task.target_files));
    }
  }

  const findings: IntegrityFinding[] = [];

  for (const task of tasks) {
    const unresolved: string[] = [];
    for (const filePath of task.target_files) {
      const existsOnDisk = existsSync(resolve(repoRoot, filePath));
      if (existsOnDisk) continue;

      // Check if any *other* task has this path in target_files with (to-create)
      let resolvedByPeer = false;
      for (const [otherId, otherPaths] of toCreateByTask) {
        if (otherId !== task.task_id && otherPaths.has(filePath)) {
          resolvedByPeer = true;
          break;
        }
      }

      if (!resolvedByPeer) {
        unresolved.push(filePath);
      }
    }

    if (unresolved.length > 0) {
      findings.push({
        rule: "target_files_resolve",
        severity: "BLOCK",
        task_id: task.task_id,
        detail: `Unresolved target file(s): ${unresolved.join(", ")}`,
      });
    }
  }

  return findings;
}
