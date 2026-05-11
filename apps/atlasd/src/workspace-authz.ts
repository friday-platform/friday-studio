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
import type { NatsConnection } from "nats";

/**
 * Roles that count as "any active member" for read/act-on-workspace
 * routes. `agent` is included — service-account members can act on
 * the workspaces they're attached to exactly like a human member.
 * Admin-tier checks narrow further; see `requireWorkspaceAdmin`.
 */
const MEMBER_ROLES: ReadonlySet<Role> = new Set(["owner", "admin", "member", "agent"]);

/** Roles that can edit config and manage non-owner members. */
const ADMIN_ROLES: ReadonlySet<Role> = new Set(["owner", "admin"]);

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
 * Two NATS round-trips run in parallel: a one-shot prefix scan of
 * `WORKSPACE_MEMBERS` and a `KvWatchInclude.UpdatesOnly` subscription
 * for live mutations under the same prefix. The returned `accessible`
 * Set reflects the snapshot by the time this resolves; the underlying
 * watcher keeps mutating it as membership rows are added or removed
 * for the lifetime of the returned handle.
 *
 * Race window: between the snapshot read and the watch attaching,
 * a row could be added or removed. With a single writer (local mode)
 * this is essentially impossible; cloud mitigates it by serializing
 * invites through the daemon. The watch's `UpdatesOnly` mode means
 * any mutation that lands after the watch attaches is delivered, so
 * the steady-state convergence is correct.
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

  // KvWatchInclude.UpdatesOnly = "updates" — `kv.watch` is typed
  // against the enum but a string literal is accepted at the wire
  // level. Imported as a string to avoid pulling the enum just for
  // this one constant.
  const [iter, snapshot] = await Promise.all([
    kv.watch({ key: `${userId}.>`, include: "updates" as never }),
    WorkspaceMemberStorage.listByUser(userId),
  ]);

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
