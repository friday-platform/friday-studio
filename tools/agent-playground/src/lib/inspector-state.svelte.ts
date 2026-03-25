/**
 * Reactive execution state for the inspector page.
 *
 * Manages the lifecycle: trigger signal → poll for session → consume SSE
 * stream → reduce into SessionView. Exposes reactive state for downstream
 * zones (waterfall, inspection panel).
 *
 * @module
 */

import {
  initialSessionView,
  reduceSessionEvent,
} from "@atlas/core/session/session-reducer";
import type {
  AgentBlock,
  SessionView,
} from "@atlas/core/session/session-events";
import { getDaemonClient } from "./daemon-client.ts";
import { fetchSessionView, sessionEventStream } from "./utils/session-event-stream.ts";
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

/** Schema for FSM step entries from the jobs endpoint. */
const FsmStepSchema = z.object({
  id: z.string(),
  stateId: z.string(),
  agentId: z.string().optional(),
  prompt: z.string().optional(),
}).passthrough();

type FsmStep = z.infer<typeof FsmStepSchema>;

const JobConfigResponseSchema = z.object({
  agents: z.array(FsmStepSchema),
}).passthrough();

/** Schema for workspace-level agent definitions from workspace config. */
const WorkspaceAgentDefSchema = z.object({
  type: z.string().optional(),
  agent: z.string().optional(),
  description: z.string().optional(),
}).passthrough();

const WorkspaceConfigResponseSchema = z.object({
  config: z.object({
    agents: z.record(z.string(), WorkspaceAgentDefSchema),
  }).passthrough(),
}).passthrough();

/** Map raw workspace agent types to user-friendly labels. */
const AGENT_TYPE_LABELS: Record<string, string> = {
  atlas: "built-in",
  llm: "llm",
  system: "system",
};

/** How often to poll for the new session after triggering (ms). */
const POLL_INTERVAL_MS = 300;

/** Max time to wait for a session to appear after trigger (ms). */
const POLL_TIMEOUT_MS = 15_000;

/** Create a new inspector execution state instance. */
export function createInspectorState() {
  let sessionView = $state<SessionView | null>(null);
  let isExecuting = $state(false);
  let selectedBlock = $state<AgentBlock | null>(null);
  let error = $state<string | null>(null);
  let abortController = $state<AbortController | null>(null);
  let disabledSteps = $state<Set<string>>(new Set());
  let fsmSteps = $state<FsmStep[]>([]);
  let workspaceAgentDefs = $state<Record<string, z.infer<typeof WorkspaceAgentDefSchema>>>({});

  /**
   * Trigger a signal and stream execution events into sessionView.
   *
   * Flow:
   * 1. POST /api/daemon/api/workspaces/:workspaceId/signals/:signalId (fire, don't await)
   * 2. Poll GET /api/daemon/api/workspaces/:workspaceId/sessions for new active session
   * 3. Subscribe to sessionEventStream(sessionId)
   * 4. Reduce events into sessionView
   */
  async function run(
    workspaceId: string,
    signalId: string,
    payload: Record<string, unknown>,
    skipStates?: string[],
  ) {
    if (isExecuting) return;

    // Reset state
    sessionView = initialSessionView();
    selectedBlock = null;
    error = null;
    isExecuting = true;

    const controller = new AbortController();
    abortController = controller;

    try {
      // Snapshot existing session IDs before trigger
      const existingIds = await fetchSessionIds(workspaceId);

      // Fire the signal trigger (don't await — it blocks until completion)
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

      // Handle trigger errors in background
      triggerPromise.catch((err) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        error = err instanceof Error ? err.message : String(err);
      });

      // Poll for the new session
      const sessionId = await pollForNewSession(
        workspaceId,
        existingIds,
        controller.signal,
      );

      if (!sessionId) {
        error = "Timed out waiting for session to start";
        isExecuting = false;
        return;
      }

      // Subscribe to session event stream and reduce
      for await (const event of sessionEventStream(sessionId)) {
        if (controller.signal.aborted) break;
        sessionView = reduceSessionEvent(sessionView ?? initialSessionView(), event);
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      error = err instanceof Error ? err.message : String(err);
    } finally {
      isExecuting = false;
      abortController = null;
    }
  }

  /** Cancel the current execution. */
  async function stop() {
    if (!abortController) return;

    // If we have a session, try to cancel it on the daemon
    const sid = sessionView?.sessionId;
    if (sid) {
      try {
        await fetch(`/api/daemon/api/sessions/${encodeURIComponent(sid)}`, {
          method: "DELETE",
        });
      } catch {
        // Best effort — the abort will clean up the SSE subscription regardless
      }
    }

    abortController.abort();
    abortController = null;
    isExecuting = false;
  }

  /** Select an agent block for the inspection panel. */
  function selectBlock(block: AgentBlock | null) {
    selectedBlock = block;
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

  /**
   * Fetch job config (FSM steps) and workspace config (agent definitions).
   * Called by the page component when workspaceId and jobId are known.
   */
  async function fetchJobConfig(jobId: string, workspaceId: string) {
    const client = getDaemonClient();

    // Fetch FSM steps and workspace agent definitions in parallel
    const [jobResult, configResult] = await Promise.allSettled([
      fetchFsmSteps(client, jobId, workspaceId),
      fetchWorkspaceAgentDefs(workspaceId),
    ]);

    fsmSteps = jobResult.status === "fulfilled" ? jobResult.value : [];
    workspaceAgentDefs = configResult.status === "fulfilled" ? configResult.value : {};
  }

  /** Derive resolved agent metadata for the currently selected block. */
  const resolvedStepAgent = $derived.by((): ResolvedStepAgent | null => {
    if (!selectedBlock) return null;

    const { agentName, stateId } = selectedBlock;

    // Find step-level FSM config by stateId
    const stepConfig = stateId
      ? fsmSteps.find((s) => s.stateId === stateId)
      : undefined;

    // Find workspace-level agent definition by agent name
    const agentDef = workspaceAgentDefs[agentName];

    // If neither found, nothing to resolve
    if (!stepConfig && !agentDef) return null;

    const rawType = agentDef?.type ?? "unknown";

    return {
      agentId: agentName,
      agentType: AGENT_TYPE_LABELS[rawType] ?? rawType,
      agentDescription: agentDef?.description,
      stepPrompt: stepConfig?.prompt,
    };
  });

  /**
   * Load a historical session by ID.
   *
   * Uses `fetchSessionView` for a direct snapshot — no SSE needed since the
   * session is already complete.
   */
  async function loadSession(sessionId: string) {
    // Set target sessionId immediately so the URL-sync effect sees a match
    // and doesn't re-trigger loadSession before the fetch resolves.
    sessionView = { ...initialSessionView(), sessionId };
    selectedBlock = null;
    error = null;
    isExecuting = false;

    try {
      sessionView = await fetchSessionView(sessionId);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  /** Reset all execution state (e.g., when workspace/job changes). */
  function reset() {
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
    sessionView = null;
    isExecuting = false;
    selectedBlock = null;
    error = null;
    disabledSteps = new Set();
    fsmSteps = [];
    workspaceAgentDefs = {};
  }

  return {
    get sessionView() { return sessionView; },
    get sessionId() { return sessionView?.sessionId ?? null; },
    get isExecuting() { return isExecuting; },
    get selectedBlock() { return selectedBlock; },
    get error() { return error; },
    get disabledSteps() { return disabledSteps; },
    get resolvedStepAgent() { return resolvedStepAgent; },
    run,
    stop,
    loadSession,
    selectBlock,
    toggleStep,
    fetchJobConfig,
    reset,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const SessionsResponseSchema = z.object({
  sessions: z.array(z.object({ sessionId: z.string() }).passthrough()),
});

type DaemonClient = ReturnType<typeof getDaemonClient>;

/** Fetch FSM step entries from the job config endpoint. */
async function fetchFsmSteps(
  client: DaemonClient,
  jobId: string,
  workspaceId: string,
): Promise<FsmStep[]> {
  try {
    const res = await client.jobs[":jobId"][":workspaceId"].$get({
      param: { jobId, workspaceId },
    });
    if (!res.ok) return [];
    const parsed = JobConfigResponseSchema.safeParse(await res.json());
    return parsed.success ? parsed.data.agents : [];
  } catch {
    return [];
  }
}

/** Fetch workspace-level agent definitions from workspace config. */
async function fetchWorkspaceAgentDefs(
  workspaceId: string,
): Promise<Record<string, z.infer<typeof WorkspaceAgentDefSchema>>> {
  try {
    const res = await fetch(
      `/api/daemon/api/workspaces/${encodeURIComponent(workspaceId)}/config`,
    );
    if (!res.ok) return {};
    const parsed = WorkspaceConfigResponseSchema.safeParse(await res.json());
    return parsed.success ? parsed.data.config.agents : {};
  } catch {
    return {};
  }
}

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
