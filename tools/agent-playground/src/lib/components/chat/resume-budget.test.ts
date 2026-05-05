import { describe, expect, it } from "vitest";
import { nextResumeBudgetStep } from "./resume-budget.ts";

const MAX = 20;

describe("nextResumeBudgetStep", () => {
  it("resumes from a clean state on the first error of the turn", () => {
    // Cursor never advanced because the connection died before the server
    // emitted an `id:` line — common on a transport-layer failure to even
    // open the stream. We have nothing to resume from, but we still want
    // the AI SDK to retry once: the error path will surface the real
    // failure on the next tick if the second attempt fails too.
    const step = nextResumeBudgetStep({
      lastSeenEventId: undefined,
      lastSeenEventIdAtLastFailure: undefined,
      resumeAttempts: 0,
      maxTurnResumes: MAX,
    });
    expect(step).toEqual({
      nextResumeAttempts: 1,
      nextLastSeenEventIdAtLastFailure: undefined,
      shouldResume: true,
    });
  });

  it("decrements the budget on consecutive failures with no forward progress", () => {
    // Two failures at the same cursor: the resumed stream rejected
    // immediately each time (server stuck, replayDisabled buffer, etc.)
    // The budget MUST drain — that's its whole purpose.
    const step = nextResumeBudgetStep({
      lastSeenEventId: 42,
      lastSeenEventIdAtLastFailure: 42,
      resumeAttempts: 5,
      maxTurnResumes: MAX,
    });
    expect(step.nextResumeAttempts).toBe(6);
    expect(step.shouldResume).toBe(true);
  });

  it("resets the budget when the cursor advanced since the last failure", () => {
    // The previous resume reconnected, streamed events 11..50, then Chrome
    // cut the connection at the 50s cap. From the budget's perspective
    // this is NOT a tight loop — the server is healthy, the work
    // progressed. Resetting `resumeAttempts` to 0 (then incrementing to 1
    // for this attempt) means a 30-resume tool call doesn't run out of
    // attempts mid-execution.
    const step = nextResumeBudgetStep({
      lastSeenEventId: 50,
      lastSeenEventIdAtLastFailure: 10,
      resumeAttempts: 5,
      maxTurnResumes: MAX,
    });
    expect(step.nextResumeAttempts).toBe(1);
    expect(step.nextLastSeenEventIdAtLastFailure).toBe(50);
    expect(step.shouldResume).toBe(true);
  });

  it("does not treat first-failure-of-turn as forward progress when cursor is undefined", () => {
    // Both cursors undefined → false-positive risk. The reducer must NOT
    // consider undefined→undefined as progress; if it did, the very first
    // failure of the turn would always reset and the bound would be
    // off-by-one. Cursor must be DEFINED to count.
    const step = nextResumeBudgetStep({
      lastSeenEventId: undefined,
      lastSeenEventIdAtLastFailure: undefined,
      resumeAttempts: 7,
      maxTurnResumes: MAX,
    });
    expect(step.nextResumeAttempts).toBe(8);
  });

  it("does not reset when a lower id arrives mid-replay (re-emit, not progress)", () => {
    // The server re-emits open `*-start` chunks with their ORIGINAL frame
    // ids on resume — so cursor 30 followed by cursor 25 (an `*-start`
    // re-emit during the next resume) is NOT forward progress, it's
    // bookkeeping. The strict-greater check rules out this regression
    // case. Without it the budget would reset on every cap cycle even
    // when the resume only got the re-emit through before dying.
    const step = nextResumeBudgetStep({
      lastSeenEventId: 25,
      lastSeenEventIdAtLastFailure: 30,
      resumeAttempts: 5,
      maxTurnResumes: MAX,
    });
    expect(step.nextResumeAttempts).toBe(6);
    expect(step.shouldResume).toBe(true);
  });

  it("treats first-defined-cursor failure as forward progress", () => {
    // Edge case: previous failure had no cursor (transport died before
    // any event), this failure has cursor=10 (the resume succeeded enough
    // to deliver some events before the next drop). Defined != undefined,
    // so the reducer correctly reports progress and resets.
    const step = nextResumeBudgetStep({
      lastSeenEventId: 10,
      lastSeenEventIdAtLastFailure: undefined,
      resumeAttempts: 3,
      maxTurnResumes: MAX,
    });
    expect(step.nextResumeAttempts).toBe(1);
    expect(step.shouldResume).toBe(true);
  });

  it("stops resuming when the budget is exhausted at the same cursor", () => {
    // Hard ceiling. After MAX_TURN_RESUMES tries against a stuck server,
    // surface the banner. The reducer reports `shouldResume: false` and
    // the caller falls through to `error = chat.error.message`.
    const step = nextResumeBudgetStep({
      lastSeenEventId: 42,
      lastSeenEventIdAtLastFailure: 42,
      resumeAttempts: MAX,
      maxTurnResumes: MAX,
    });
    expect(step.shouldResume).toBe(false);
    expect(step.nextResumeAttempts).toBe(MAX);
    expect(step.nextLastSeenEventIdAtLastFailure).toBe(42);
  });

  it("rescues an exhausted budget when forward progress arrives at the next failure", () => {
    // Pathological-but-real: the budget hit MAX while the resume was
    // landing events. The final error fires AFTER several events made it
    // through. Forward progress overrides exhaustion — otherwise a
    // marathon turn would die just as the cap-cycle stabilizes. The rule
    // is "tight loops are bounded", not "total attempts are bounded".
    const step = nextResumeBudgetStep({
      lastSeenEventId: 200,
      lastSeenEventIdAtLastFailure: 50,
      resumeAttempts: MAX,
      maxTurnResumes: MAX,
    });
    expect(step.shouldResume).toBe(true);
    expect(step.nextResumeAttempts).toBe(1);
  });

  it("snapshots the current cursor as the new failure baseline regardless of decision", () => {
    // The caller must update `lastSeenEventIdAtLastFailure` even when the
    // budget is exhausted — otherwise a future click of "retry" couldn't
    // tell forward progress from frozen state. The reducer commits the
    // snapshot on every call.
    const exhausted = nextResumeBudgetStep({
      lastSeenEventId: 99,
      lastSeenEventIdAtLastFailure: 99,
      resumeAttempts: MAX,
      maxTurnResumes: MAX,
    });
    expect(exhausted.nextLastSeenEventIdAtLastFailure).toBe(99);

    const resuming = nextResumeBudgetStep({
      lastSeenEventId: 100,
      lastSeenEventIdAtLastFailure: 50,
      resumeAttempts: 5,
      maxTurnResumes: MAX,
    });
    expect(resuming.nextLastSeenEventIdAtLastFailure).toBe(100);
  });

  it("handles maxTurnResumes=1 (degenerate budget) correctly", () => {
    // Sanity check the boundary math. With a budget of 1, the first
    // failure resumes (attempts: 0→1) and the second failure surfaces the
    // banner. Forward progress on the second failure rescues it.
    const first = nextResumeBudgetStep({
      lastSeenEventId: undefined,
      lastSeenEventIdAtLastFailure: undefined,
      resumeAttempts: 0,
      maxTurnResumes: 1,
    });
    expect(first).toEqual({
      nextResumeAttempts: 1,
      nextLastSeenEventIdAtLastFailure: undefined,
      shouldResume: true,
    });

    const stuck = nextResumeBudgetStep({
      lastSeenEventId: undefined,
      lastSeenEventIdAtLastFailure: undefined,
      resumeAttempts: 1,
      maxTurnResumes: 1,
    });
    expect(stuck.shouldResume).toBe(false);

    const rescued = nextResumeBudgetStep({
      lastSeenEventId: 5,
      lastSeenEventIdAtLastFailure: undefined,
      resumeAttempts: 1,
      maxTurnResumes: 1,
    });
    expect(rescued.shouldResume).toBe(true);
    expect(rescued.nextResumeAttempts).toBe(1);
  });
});
