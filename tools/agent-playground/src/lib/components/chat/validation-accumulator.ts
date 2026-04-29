/**
 * Pure accumulator that folds a stream of `SessionStreamEvent`s into a map of
 * validation-attempt displays keyed by parent `actionId`.
 *
 * The chunk accumulator in {@link ./chunk-accumulator.ts} handles tool-call
 * lifecycle keyed by `toolCallId`; this module handles the orthogonal
 * validation lifecycle keyed by `actionId`. They are kept separate because the
 * source streams (AI SDK chat chunks vs. session SSE events), keying schemes,
 * and output shapes do not overlap.
 *
 * @module
 */

import type { SessionStreamEvent } from "@atlas/core/session/session-events";
import type { ValidationVerdict } from "@atlas/hallucination/verdict";

/**
 * Per-attempt display row consumed by `<ValidationPillRow>`. One entry exists
 * per `(actionId, attempt)` pair; the entry transitions from `running` to a
 * terminal `passed` or `failed` state as later events for the same pair arrive.
 */
export interface ValidationAttemptDisplay {
  attempt: number;
  status: "running" | "passed" | "failed";
  /** Present on `failed`; `true` only on terminal failure. */
  terminal?: boolean;
  /** Present on terminal events; absent on `running`. */
  verdict?: ValidationVerdict;
}

const KNOWN_STATUSES = new Set(["running", "passed", "failed"]);

/**
 * Fold an iterable of session stream events into a map of validation attempt
 * arrays keyed by `actionId`. Per-action arrays are sorted ascending by
 * `attempt` index so callers can render pills in chronological order without
 * re-sorting.
 *
 * Trust contract: events that fail correlation (missing `actionId`) or use an
 * unknown `status` do not produce silent drops — they emit a `console.warn` so
 * a future schema-drift bug is loud rather than invisible.
 */
export function accumulateValidationAttempts(
  events: Iterable<SessionStreamEvent>,
): Map<string, ValidationAttemptDisplay[]> {
  const byAction = new Map<string, Map<number, ValidationAttemptDisplay>>();

  for (const event of events) {
    if (event.type !== "step:validation") continue;

    const actionId = event.actionId;
    if (typeof actionId !== "string" || actionId.length === 0) {
      console.warn("validation-accumulator: dropping event with no actionId", {
        attempt: event.attempt,
        status: event.status,
      });
      continue;
    }

    if (!KNOWN_STATUSES.has(event.status)) {
      console.warn("validation-accumulator: dropping event with unknown status", {
        actionId,
        attempt: event.attempt,
        status: event.status,
      });
      continue;
    }

    let attempts = byAction.get(actionId);
    if (!attempts) {
      attempts = new Map();
      byAction.set(actionId, attempts);
    }

    const existing = attempts.get(event.attempt);
    const next: ValidationAttemptDisplay = {
      attempt: event.attempt,
      status: event.status,
      ...(event.terminal !== undefined && { terminal: event.terminal }),
      ...(event.verdict !== undefined && { verdict: event.verdict }),
    };

    if (!existing) {
      attempts.set(event.attempt, next);
      continue;
    }

    // Re-applying a `running` over a terminal entry would regress the pill.
    // Keep terminal state once reached; only `running` → terminal transitions.
    if (existing.status !== "running" && event.status === "running") continue;

    attempts.set(event.attempt, next);
  }

  const result = new Map<string, ValidationAttemptDisplay[]>();
  for (const [actionId, attempts] of byAction) {
    const sorted = Array.from(attempts.values()).sort((a, b) => a.attempt - b.attempt);
    result.set(actionId, sorted);
  }
  return result;
}
