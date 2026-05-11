/**
 * Session inventory tools for workspace chat.
 *
 * Sessions previously had no read tool — the chat agent couldn't answer
 * "did my Slack signal fire?" or "what was that error?" without dropping
 * to `run_code` curl. These tools route to the daemon's existing
 * `/api/sessions` endpoint family.
 */

import type { AtlasTools } from "@atlas/agent-sdk";
import type { Logger } from "@atlas/logger";
import { getAtlasDaemonUrl } from "@atlas/oapi-client";
import { stringifyError } from "@atlas/utils";
import { tool } from "ai";
import { z } from "zod";

const SessionScope = z
  .enum(["workspace", "all"])
  .default("workspace")
  .describe(
    "Where to look. 'workspace' (default) — sessions in this chat's workspace. " +
      "'all' — every session the daemon knows about, across workspaces.",
  );

async function daemonGet<T>(
  path: string,
  logger: Logger,
  op: string,
): Promise<{ ok: boolean; data?: T; error?: string }> {
  const url = `${getAtlasDaemonUrl()}${path}`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      logger.warn(`${op} failed`, { url, status: res.status });
      const text = await res.text();
      return { ok: false, error: `${op} failed: HTTP ${res.status}${text ? `: ${text}` : ""}` };
    }
    return { ok: true, data: (await res.json()) as T };
  } catch (err) {
    logger.warn(`${op} threw`, { url, error: stringifyError(err) });
    return { ok: false, error: `${op} failed: network error` };
  }
}

export function createListSessionsTool(defaultWorkspaceId: string, logger: Logger): AtlasTools {
  return {
    list_sessions: tool({
      description:
        "List session summaries — id, status, jobName, task, startedAt, durationMs, agent names. " +
        "Default scope='workspace' returns sessions in this chat's workspace. scope='all' " +
        "returns every session across workspaces. Optional `limit` caps the result; the daemon " +
        "returns sessions newest-first. To inspect a single session's full event stream, follow " +
        "up with `describe_session(id)`.",
      inputSchema: z.object({
        scope: SessionScope.optional(),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .default(50)
          .optional()
          .describe("Max sessions to return. Defaults to 50, hard cap 200."),
      }),
      execute: async ({ scope, limit }) => {
        const target = scope ?? "workspace";
        const params = new URLSearchParams();
        if (target === "workspace") {
          params.set("workspaceId", defaultWorkspaceId);
        }
        const result = await daemonGet<{ sessions?: unknown[] }>(
          `/api/sessions${params.toString() ? `?${params.toString()}` : ""}`,
          logger,
          "list_sessions",
        );
        if (!result.ok) return { ok: false as const, error: result.error };
        const all = Array.isArray(result.data?.sessions) ? result.data.sessions : [];
        const cap = limit ?? 50;
        const sessions = all.slice(0, cap);
        return {
          ok: true as const,
          scope: target,
          sessions,
          count: sessions.length,
          total: all.length,
        };
      },
    }),
  };
}

export function createDescribeSessionTool(logger: Logger): AtlasTools {
  return {
    describe_session: tool({
      description:
        "Return a session's full SessionView — agent blocks, status, durations, AI summary, " +
        "and per-step usage. Use this to answer 'did the signal fire?' / 'what error did the " +
        "job throw?' without bouncing through `run_code` curl. The session id comes from " +
        "list_sessions or from a `data-session-start` event in chat history.",
      inputSchema: z.object({ id: z.string().min(1).describe("Session id (UUID).") }),
      execute: async ({ id }) => {
        const result = await daemonGet<unknown>(
          `/api/sessions/${encodeURIComponent(id)}`,
          logger,
          "describe_session",
        );
        if (!result.ok) return { ok: false as const, error: result.error };
        return { ok: true as const, session: result.data };
      },
    }),
  };
}
