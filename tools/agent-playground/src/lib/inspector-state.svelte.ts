/**
 * Reactive execution control for the inspector page.
 *
 * Manages the trigger phase: signal → poll for session ID. Streaming and
 * session view are handled by TanStack Query via experimental_streamedQuery
 * in session-queries.ts.
 *
 * @module
 */

import { z } from "zod";

/**
 * Resolved agent metadata for a selected step, combining workspace-level agent
 * identity with step-level FSM config.
 */
export interface ResolvedStepAgent {
  agentId: string;
  agentType: string;
  agentDescription?: string;
  stepPrompt?: string;
}

/** How often to poll for the new session after triggering (ms). */
const POLL_INTERVAL_MS = 300;

/** Max time to wait for a session to appear after trigger (ms). */
const POLL_TIMEOUT_MS = 15_000;

/** Create a new inspector execution control instance. */
export function createInspectorState() {
  let isTriggering = $state(false);
  let error = $state<string | null>(null);
  let abortController = $state<AbortController | null>(null);
  let disabledSteps = $state<Set<string>>(new Set());

  /**
   * Trigger a signal and poll for the resulting session ID.
   *
   * Returns the session ID on success, which the caller should push to the URL.
   * Streaming is handled by TanStack Query (sessionQueries.view).
   *
   * Flow:
   * 1. POST /api/daemon/api/workspaces/:workspaceId/signals/:signalId
   * 2. Poll GET /api/daemon/api/workspaces/:workspaceId/sessions for new session
   * 3. Return session ID (caller updates URL → query starts streaming)
   */
  async function run(
    workspaceId: string,
    signalId: string,
    payload: Record<string, unknown>,
    skipStates?: string[],
  ): Promise<string | null> {
    if (isTriggering) return null;

    error = null;
    isTriggering = true;

    const controller = new AbortController();
    abortController = controller;

    try {
      const existingIds = await fetchSessionIds(workspaceId);

      const triggerUrl = `/api/daemon/api/workspaces/${encodeURIComponent(workspaceId)}/signals/${encodeURIComponent(signalId)}`;
      const triggerBody: Record<string, unknown> = { payload };
      if (skipStates && skipStates.length > 0) {
        triggerBody.skipStates = skipStates;
      }

      const triggerPromise = fetch(triggerUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(triggerBody),
        signal: controller.signal,
      });

      triggerPromise.catch((err) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        error = err instanceof Error ? err.message : String(err);
      });

      const sessionId = await pollForNewSession(
        workspaceId,
        existingIds,
        controller.signal,
      );

      if (!sessionId) {
        error = "Timed out waiting for session to start";
      }

      return sessionId;
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return null;
      error = err instanceof Error ? err.message : String(err);
      return null;
    } finally {
      isTriggering = false;
      abortController = null;
    }
  }

  /** Cancel the current trigger phase. */
  function cancel() {
    if (!abortController) return;
    abortController.abort();
    abortController = null;
    isTriggering = false;
  }

  /** Toggle a step's disabled state. Adds if absent, removes if present. */
  function toggleStep(stateId: string) {
    const next = new Set(disabledSteps);
    if (next.has(stateId)) {
      next.delete(stateId);
    } else {
      next.add(stateId);
    }
    disabledSteps = next;
  }

  /** Reset all state (e.g., when workspace/job changes). */
  function reset() {
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
    isTriggering = false;
    error = null;
    disabledSteps = new Set();
  }

  return {
    get isTriggering() { return isTriggering; },
    get error() { return error; },
    get disabledSteps() { return disabledSteps; },
    run,
    cancel,
    toggleStep,
    reset,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const SessionsResponseSchema = z.object({
  sessions: z.array(z.object({ sessionId: z.string() }).passthrough()),
});

/** Fetch current session IDs for a workspace. */
async function fetchSessionIds(workspaceId: string): Promise<Set<string>> {
  const res = await fetch(
    `/api/daemon/api/sessions?workspaceId=${encodeURIComponent(workspaceId)}`,
  );
  if (!res.ok) return new Set();
  const parsed = SessionsResponseSchema.safeParse(await res.json());
  if (!parsed.success) return new Set();
  return new Set(parsed.data.sessions.map((s) => s.sessionId));
}

/** Poll workspace sessions until a new session appears or timeout. */
async function pollForNewSession(
  workspaceId: string,
  existingIds: Set<string>,
  signal: AbortSignal,
): Promise<string | null> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (signal.aborted) return null;

    const currentIds = await fetchSessionIds(workspaceId);
    for (const id of currentIds) {
      if (!existingIds.has(id)) return id;
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, POLL_INTERVAL_MS);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }

  return null;
}
