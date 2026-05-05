/**
 * Pure step-reducer for the mid-turn SSE resume budget.
 *
 * Chrome caps `fetch` streaming at ~50–60s — every long turn (a multi-minute
 * tool call) hits the cap several times even when the server is fine. The
 * caller transparently retries via `chat.resumeStream()` and bounds the
 * retry count with `MAX_TURN_RESUMES` so a genuinely broken server can't
 * loop forever.
 *
 * The naive bound (decrement on every error) silently truncates legitimate
 * long turns: each Chrome cap consumes one attempt regardless of whether
 * the previous resume actually delivered events. A 25-minute tool call
 * across 30 reconnects would die at minute ~17 with the budget exhausted.
 *
 * Forward progress between failures means the previous resume succeeded —
 * the next failure is a NEW Chrome cap, not a retry of the same broken
 * state. Reset the counter on forward progress so the budget stays a
 * tight-loop guard, not a turn-length guillotine.
 *
 * Pure: given the same inputs, always returns a fresh decision. The caller
 * holds the mutable `resumeAttempts` / `lastSeenEventIdAtLastFailure` cells
 * (Svelte runes in `user-chat.svelte`) and applies this reducer's outputs.
 *
 * @module
 */

/** Inputs the reducer needs to decide the next resume step. */
export interface ResumeBudgetInput {
  /** Highest SSE event id seen since the turn started, or undefined if none. */
  lastSeenEventId: number | undefined;
  /** Cursor value at the previous failure, or undefined if this is the first failure of the turn. */
  lastSeenEventIdAtLastFailure: number | undefined;
  /** Resume attempts already spent on this turn. */
  resumeAttempts: number;
  /** Hard ceiling on attempts per turn — bounds tight loops on a stuck server. */
  maxTurnResumes: number;
}

/**
 * Decision the caller applies to its mutable state cells.
 *
 * - `nextResumeAttempts`: the new value for `resumeAttempts` AFTER the
 *   reducer's bookkeeping (forward-progress reset, then increment if
 *   resuming). The caller assigns this even when `shouldResume === false`
 *   to keep the cell consistent.
 * - `nextLastSeenEventIdAtLastFailure`: snapshot of the cursor at this
 *   failure. The caller assigns this unconditionally so the next failure
 *   can decide forward progress vs same-state retry.
 * - `shouldResume`: when true, the caller calls `chat.resumeStream()`. When
 *   false, the budget is exhausted and the caller surfaces the banner.
 */
export interface ResumeBudgetStep {
  nextResumeAttempts: number;
  nextLastSeenEventIdAtLastFailure: number | undefined;
  shouldResume: boolean;
}

/**
 * Compute the next step for the resume budget on a fresh `chat.error`.
 *
 * Forward-progress detection: the current cursor is defined AND either
 * (a) the previous failure had no cursor (first defined-cursor failure
 * of the turn is itself progress over the unset baseline) or (b) the
 * current cursor is strictly greater than the previous one. The strict
 * inequality matters because the StreamRegistry re-emits open `*-start`
 * chunks with their ORIGINAL frame ids on resume — a lower id arriving
 * mid-replay is NOT progress, just bookkeeping. The "defined" check on
 * `lastSeenEventId` removes the undefined→undefined false positive at
 * the very first failure of a turn that died before any event arrived.
 */
export function nextResumeBudgetStep(input: ResumeBudgetInput): ResumeBudgetStep {
  const { lastSeenEventId, lastSeenEventIdAtLastFailure, resumeAttempts, maxTurnResumes } = input;

  const madeForwardProgress =
    lastSeenEventId !== undefined &&
    (lastSeenEventIdAtLastFailure === undefined ||
      lastSeenEventId > lastSeenEventIdAtLastFailure);

  const baselineAttempts = madeForwardProgress ? 0 : resumeAttempts;

  if (baselineAttempts >= maxTurnResumes) {
    return {
      nextResumeAttempts: baselineAttempts,
      nextLastSeenEventIdAtLastFailure: lastSeenEventId,
      shouldResume: false,
    };
  }

  return {
    nextResumeAttempts: baselineAttempts + 1,
    nextLastSeenEventIdAtLastFailure: lastSeenEventId,
    shouldResume: true,
  };
}
