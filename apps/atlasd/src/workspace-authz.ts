/**
 * Workspace-membership authz helpers.
 *
 * Reads against the `WORKSPACE_MEMBERS` KV bucket. The firehose builds
 * on top of `openAccessibleWorkspaceWatch` (snapshot + live watch);
 * HTTP middleware (added in a follow-up) builds on top of
 * `getMembership` for single-key checks.
 *
 * @module
 */

import {
  ensureWorkspaceMembersKVBucket,
  WorkspaceMemberStorage,
} from "@atlas/core/workspace-members/storage";
import type { NatsConnection } from "nats";

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
