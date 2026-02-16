/**
 * Deterministic topological sort using Kahn's algorithm.
 *
 * Shared by the planner (DAG validation) and compiler (DAG → FSM linearization).
 * Returns full step objects in sorted order with deterministic tie-breaking (lexicographic by ID).
 */

import type { Result } from "./types.ts";

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export interface TopologicalSortError {
  type: "cycle_detected" | "missing_dependency" | "no_root_steps" | "duplicate_step_id";
  message: string;
  context?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Core algorithm
// ---------------------------------------------------------------------------

/** Minimal shape required for topological sorting. */
interface Sortable {
  id: string;
  depends_on: string[];
}

/**
 * Deterministic topological sort via Kahn's algorithm.
 *
 * Pre-validates for duplicate IDs, missing dependencies, and no-root-steps,
 * then runs the sort with lexicographic tie-breaking for determinism.
 *
 * @returns Sorted elements on success, structured errors on failure
 */
export function topologicalSort<T extends Sortable>(
  steps: T[],
): Result<T[], TopologicalSortError[]> {
  const errors: TopologicalSortError[] = [];

  // Duplicate ID check
  const ids = new Set<string>();
  for (const step of steps) {
    if (ids.has(step.id)) {
      errors.push({
        type: "duplicate_step_id",
        message: `Duplicate step ID: '${step.id}'`,
        context: { stepId: step.id },
      });
    }
    ids.add(step.id);
  }
  if (errors.length > 0) return { success: false, error: errors };

  // Missing dependency check
  for (const step of steps) {
    for (const dep of step.depends_on) {
      if (!ids.has(dep)) {
        errors.push({
          type: "missing_dependency",
          message: `Step '${step.id}' depends on unknown step '${dep}'`,
          context: { stepId: step.id, dependency: dep },
        });
      }
    }
  }
  if (errors.length > 0) return { success: false, error: errors };

  // Root steps check
  if (!steps.some((s) => s.depends_on.length === 0)) {
    return {
      success: false,
      error: [
        { type: "no_root_steps", message: "Job has no root steps (all steps have dependencies)" },
      ],
    };
  }

  // Kahn's algorithm with deterministic ordering
  const stepMap = new Map(steps.map((s) => [s.id, s]));
  const inDegree = new Map(steps.map((s) => [s.id, s.depends_on.length]));

  const queue: string[] = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) queue.push(id);
  }
  queue.sort();

  const result: T[] = [];
  while (queue.length > 0) {
    queue.sort(); // deterministic: always pick lexicographically first
    const current = queue.shift();
    if (current === undefined) break;
    const currentStep = stepMap.get(current);
    if (!currentStep) continue;
    result.push(currentStep);

    for (const step of steps) {
      if (step.depends_on.includes(current)) {
        const newDegree = (inDegree.get(step.id) ?? 0) - 1;
        inDegree.set(step.id, newDegree);
        if (newDegree === 0) queue.push(step.id);
      }
    }
  }

  if (result.length !== steps.length) {
    return {
      success: false,
      error: [
        {
          type: "cycle_detected",
          message: "Cycle detected in step dependencies",
          context: { processedSteps: result.map((s) => s.id), allSteps: steps.map((s) => s.id) },
        },
      ],
    };
  }

  return { success: true, value: result };
}
