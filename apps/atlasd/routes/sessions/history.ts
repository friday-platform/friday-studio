import { ReasoningResultStatus, type SessionHistoryListItem } from "@atlas/core";
import {
  buildSessionDigest,
  type DigestArtifact,
  type DigestError,
  type DigestInput,
  type DigestStep,
} from "@atlas/core/session/build-session-digest";
import { SessionHistoryStorage } from "@atlas/core/session/history-storage";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { daemonFactory } from "../../src/factory.ts";

/**
 * API response type for session digest endpoint.
 * Extends SessionDigest with runtime fields (workspaceName, isLive, progress).
 *
 * We define this explicitly so Hono's type inference produces a single shape
 * rather than a union of in-progress vs completed sessions. Without this,
 * TypeScript strips `undefined` values from JSON responses, causing the client
 * to see a union where optional fields don't exist on in-progress sessions.
 */
interface SessionDigestResponse {
  id: string;
  status: string;
  type?: "task" | "conversation";
  durationMs?: number;
  createdAt: string;
  workspaceId: string;
  workspaceName?: string;
  title?: string;
  summary?: string;
  parentStreamId?: string;
  parentTitle?: string;
  input: DigestInput;
  output?: unknown;
  steps: DigestStep[];
  errors: DigestError[];
  outputContent?: string;
  artifacts: DigestArtifact[];
  primaryError?: string;
  /** True for in-progress sessions (live view), false for completed */
  isLive: boolean;
  /** Progress percentage (0-100) for in-progress sessions */
  progress?: number;
}

/** System workspaces that should be excluded from session history listings */
const SYSTEM_WORKSPACE_IDS = ["friday-conversation"];

const ListSessionHistoryQuery = z.object({ workspaceId: z.string().optional() });

const GetSessionHistoryParams = z.object({ id: z.string() });

const sessionHistoryRoutes = daemonFactory
  .createApp()
  /** List session history for a workspace (includes active/in-progress sessions) */
  .get("/", zValidator("query", ListSessionHistoryQuery), async (c) => {
    const { workspaceId } = c.req.valid("query");
    // Don't exclude at storage level - we filter below to allow task sessions through
    const result = await SessionHistoryStorage.listSessions({ workspaceId });

    if (!result.ok) {
      return c.json({ error: result.error }, 500);
    }

    // Build workspace name lookup
    const ctx = c.get("app");
    const manager = ctx.getWorkspaceManager();
    const workspaces = await manager.list({ includeSystem: true });
    const workspaceNames = new Map(workspaces.map((w) => [w.id, w.name]));

    // Get active sessions from all runtimes and transform to list item shape
    const activeSessions: (SessionHistoryListItem & { workspaceName?: string })[] = [];
    for (const [runtimeWorkspaceId, runtime] of ctx.daemon.runtimes) {
      // Skip if filtering by workspaceId and this doesn't match
      if (workspaceId && runtimeWorkspaceId !== workspaceId) continue;
      // Skip system workspaces
      if (SYSTEM_WORKSPACE_IDS.includes(runtimeWorkspaceId)) continue;

      for (const activeSession of runtime.getSessions()) {
        activeSessions.push({
          sessionId: activeSession.id,
          workspaceId: runtimeWorkspaceId,
          workspaceName: workspaceNames.get(runtimeWorkspaceId),
          status: ReasoningResultStatus.PARTIAL, // "partial" means in-progress
          createdAt: activeSession.startedAt.toISOString(),
          updatedAt: new Date().toISOString(),
          summary: activeSession.session.summarize(),
          title: undefined, // Title is generated at completion
          sessionType: undefined, // Could be set if we had more context
        });
      }
    }

    // Filter out system workspace sessions from history, but keep task sessions
    const historySessions = result.data.sessions
      .filter((s) => s.sessionType === "task" || !SYSTEM_WORKSPACE_IDS.includes(s.workspaceId))
      .map((s) => ({ ...s, workspaceName: workspaceNames.get(s.workspaceId) }));

    // Merge: active sessions first (most relevant), then history by date
    const sessions = [...activeSessions, ...historySessions];

    return c.json({ sessions }, 200);
  })
  /** Get session digest (transformed from timeline events, or simplified for active sessions) */
  .get("/:id", zValidator("param", GetSessionHistoryParams), async (c) => {
    const { id } = c.req.valid("param");
    const ctx = c.get("app");
    const manager = ctx.getWorkspaceManager();

    // 1. Check active sessions first (in-memory)
    for (const [workspaceId, runtime] of ctx.daemon.runtimes) {
      const activeSession = runtime.getSessions().find((s) => s.id === id);
      if (activeSession) {
        const workspace = await manager.find({ id: workspaceId });
        const now = new Date();
        const durationMs = now.getTime() - activeSession.startedAt.getTime();

        // Return simplified digest for in-progress session
        // Use satisfies to ensure type matches completed session shape
        const response: SessionDigestResponse = {
          id: activeSession.id,
          status: ReasoningResultStatus.PARTIAL, // "partial" = in-progress
          type: undefined,
          durationMs,
          createdAt: activeSession.startedAt.toISOString(),
          workspaceId,
          workspaceName: workspace?.name,
          title: undefined, // Title generated at completion
          summary: activeSession.session.summarize(),
          parentStreamId: undefined,
          parentTitle: undefined,
          input: {
            task: activeSession.session.summarize(),
            signalPayload: undefined, // Not exposed on ActiveSession
          },
          output: undefined, // No output yet
          steps: [], // No step data available for in-progress
          errors: [],
          // UI-friendly extracted fields (empty for in-progress)
          outputContent: undefined,
          artifacts: [],
          primaryError: undefined,
          // Flag to indicate this is a live/simplified view
          isLive: true,
          progress: activeSession.session.progress(),
        };
        return c.json(response, 200);
      }
    }

    // 2. Fallback to history storage for completed sessions
    const result = await SessionHistoryStorage.loadSessionTimeline(id);

    if (!result.ok) {
      return c.json({ error: result.error }, 500);
    }

    if (!result.data) {
      return c.json({ error: "Session not found" }, 404);
    }

    const digest = buildSessionDigest(result.data);

    // Add workspace name
    const workspace = await manager.find({ id: result.data.metadata.workspaceId });

    const response: SessionDigestResponse = {
      ...digest,
      workspaceName: workspace?.name,
      isLive: false,
    };
    return c.json(response, 200);
  });

export { sessionHistoryRoutes };
export type SessionHistoryRoutes = typeof sessionHistoryRoutes;
