/**
 * Workspace-membership authz helpers.
 *
 * Reads against the `WORKSPACE_MEMBERS` KV bucket. The firehose builds
 * on top of `openAccessibleWorkspaceWatch` (snapshot + live watch);
 * HTTP route handlers gate on `requireWorkspaceMember` /
 * `requireWorkspaceAdmin` for per-request checks.
 *
 * @module
 */

import {
  ensureWorkspaceMembersKVBucket,
  type Role,
  WorkspaceMemberStorage,
  type WorkspaceMembership,
} from "@atlas/core/workspace-members/storage";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { KvWatchInclude, type NatsConnection } from "nats";

/**
 * Roles that count as "any active member" for read/act-on-workspace
 * routes. `agent` is included — service-account members can act on
 * the workspaces they're attached to exactly like a human member.
 * Admin-tier checks narrow further; see `requireWorkspaceAdmin`.
 */
const MEMBER_ROLES: ReadonlySet<Role> = new Set<Role>(["owner", "admin", "member", "agent"]);

/** Roles that can edit config and manage non-owner members. */
const ADMIN_ROLES: ReadonlySet<Role> = new Set<Role>(["owner", "admin"]);

/**
 * Resolve the current request's userId, defending against the
 * middleware-not-mounted case. Production routes never see this throw —
 * the session middleware sets `userId` on every authenticated request.
 */
function requireUserId(c: Context): string {
  const userId = c.get("userId") as string | undefined;
  if (!userId) {
    throw new HTTPException(401, { message: "Unauthorized" });
  }
  return userId;
}

async function loadMembership(
  c: Context,
  workspaceId: string,
): Promise<WorkspaceMembership | null> {
  if (!workspaceId) {
    throw new HTTPException(400, { message: "Missing workspaceId" });
  }
  const userId = requireUserId(c);
  const result = await WorkspaceMemberStorage.get(userId, workspaceId);
  if (!result.ok) {
    throw new HTTPException(500, {
      message: `Failed to read workspace membership: ${result.error}`,
    });
  }
  return result.data;
}

/**
 * Require the caller to be a member of the workspace in any role
 * (owner | admin | member | agent). Throws `HTTPException(403)` if
 * the userId has no membership row for the workspace; throws 401 if
 * the request has no userId (session middleware bypass).
 *
 * Returns the resolved Membership so handlers can branch on role
 * without an extra lookup.
 */
export async function requireWorkspaceMember(
  c: Context,
  workspaceId: string,
): Promise<WorkspaceMembership> {
  const membership = await loadMembership(c, workspaceId);
  if (!membership || !MEMBER_ROLES.has(membership.role)) {
    throw new HTTPException(403, { message: "Forbidden" });
  }
  return membership;
}

/**
 * Require the caller to be an `owner` or `admin` of the workspace.
 * Members and agents do not pass this check. Used by routes that
 * edit workspace config, toggle persistence, manage communicator
 * wiring, or pause/resume schedules.
 */
export async function requireWorkspaceAdmin(
  c: Context,
  workspaceId: string,
): Promise<WorkspaceMembership> {
  const membership = await loadMembership(c, workspaceId);
  if (!membership || !ADMIN_ROLES.has(membership.role)) {
    throw new HTTPException(403, { message: "Forbidden" });
  }
  return membership;
}

/**
 * One-shot snapshot of every workspaceId the caller is a member of.
 *
 * For HTTP request handlers that need to filter a listing or check
 * one wsId — no watch, no background loop. The firehose uses
 * `openAccessibleWorkspaceWatch` instead for its long-lived case.
 *
 * Fail-closed on storage errors: an empty set is the safe default
 * when the membership lookup fails.
 */
export async function getAccessibleWorkspaceIds(userId: string): Promise<Set<string>> {
  const result = await WorkspaceMemberStorage.listByUser(userId);
  if (!result.ok) return new Set();
  return new Set(result.data.map((m) => m.wsId));
}

/**
 * Open a live-watched accessible-workspaces set for one user.
 *
 * Sequence matters here, in this order:
 *   1. Attach the `UpdatesOnly` watch — establishes the boundary so
 *      every mutation from this point is delivered to the iterator.
 *   2. `nc.flush()` — round-trips with the broker so the watch's
 *      JetStream consumer is registered server-side. Without it, a
 *      PUT/DEL published in the subscribe-returns-but-broker-not-ready
 *      window is silently dropped.
 *   3. Snapshot via `listByUser` — reads at a revision strictly
 *      ≥ the watch start. Any add/delete between the two is delivered
 *      to the watch iterator (already attached) and applied after the
 *      foreground loop kicks in.
 *
 * That ordering closes the snapshot/watch race entirely: stale rows
 * from the snapshot get overridden by later DEL events from the
 * watch; new rows missed by the snapshot show up via the watch's
 * UpdatesOnly stream. The previous parallelized variant left a
 * window where a DEL could land before the watch attached and after
 * the snapshot's read revision, producing a permanently-stale entry.
 *
 * Failure mode is fail-closed: if either side fails the user sees
 * an empty set rather than wildcard access.
 *
 * Call `stop()` to release the underlying NATS subscription when the
 * connection that needs the set goes away.
 */
export async function openAccessibleWorkspaceWatch(
  nc: NatsConnection,
  userId: string,
): Promise<{ accessible: Set<string>; stop: () => Promise<void> }> {
  const kv = await ensureWorkspaceMembersKVBucket(nc);
  const accessible = new Set<string>();
  const prefix = `${userId}.`;

  // `kv.watch` resolves AFTER the ordered JetStream consumer is
  // registered server-side — it's a request/response handshake over
  // JetStream's control subject, not a fire-and-forget core sub. So
  // the await itself is the synchronization point; no subscribe-then-
  // flush dance needed. The snapshot below reads at a revision
  // strictly ≥ the watch start, so any DEL/PUT that lands between the
  // two is delivered to the watch iterator and applied later by the
  // foreground loop.
  const iter = await kv.watch({ key: `${userId}.>`, include: KvWatchInclude.UpdatesOnly });

  const snapshot = await WorkspaceMemberStorage.listByUser(userId);
  if (snapshot.ok) {
    for (const m of snapshot.data) accessible.add(m.wsId);
  }

  // Background loop: apply live entries until `stop()` is called.
  void (async () => {
    try {
      for await (const entry of iter) {
        const wsId = entry.key.slice(prefix.length);
        if (entry.operation === "PUT") accessible.add(wsId);
        else if (entry.operation === "DEL" || entry.operation === "PURGE") {
          accessible.delete(wsId);
        }
      }
    } catch {
      // Iterator stopped — teardown owns cleanup; no logging here.
    }
  })();

  return {
    accessible,
    async stop() {
      try {
        await iter.stop();
      } catch {
        // already stopped
      }
    },
  };
}
