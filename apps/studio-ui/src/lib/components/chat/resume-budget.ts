/**
 * Pure step-reducer for the mid-turn SSE resume budget.
 *
 * Chrome's ~50s fetch streaming cap consumes one resume attempt per drop
 * regardless of whether the previous resume actually delivered events. A
 * naive decrement-on-error bound truncates legitimate long turns at minute
 * ~17 of a 25-minute tool call.
 *
 * Forward progress between failures means the previous resume succeeded —
 * the next failure is a NEW cap, not a retry of the same broken state.
 * Reset the counter on progress so the budget stays a tight-loop guard,
 * not a turn-length guillotine.
 */

export interface ResumeBudgetInput {
  lastSeenEventId: number | undefined;
  lastSeenEventIdAtLastFailure: number | undefined;
  resumeAttempts: number;
  maxTurnResumes: number;
}

export interface ResumeBudgetStep {
  nextResumeAttempts: number;
  nextLastSeenEventIdAtLastFailure: number | undefined;
  shouldResume: boolean;
}

/**
 * Strict-greater forward-progress check: StreamRegistry re-emits open
 * `*-start` chunks at their ORIGINAL frame ids on resume, so a lower id
 * mid-replay is bookkeeping, not progress. The defined-check on
 * `lastSeenEventId` rules out the undefined→undefined false positive
 * when a turn dies before any event arrives.
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
