/**
 * JetStream-backed workspace membership store.
 *
 * Single bucket `WORKSPACE_MEMBERS` keyed by `<userId>.<wsId>`. The
 * userId-first key shape makes the hot lookup — "what workspaces can
 * this user see?" — a clean prefix scan; that question runs once per
 * firehose handshake and once per HTTP request that touches a
 * workspace-scoped surface. The reverse direction ("list members of
 * workspace X") is a full bucket scan with a filter, acceptable
 * because it only powers admin UIs.
 *
 * Roles:
 *   - `owner`  — full control: edit config, manage members, transfer
 *                ownership, delete the workspace. One per workspace
 *                (invariant enforced by the layer above this store).
 *   - `admin`  — edit config, invite/remove non-owner members.
 *   - `member` — read state, act in the workspace (chat, run agents,
 *                answer elicitations).
 *   - `agent`  — same capabilities as `member`; distinct so service
 *                accounts can be listed separately in admin UIs.
 *
 * This file is the dumb-storage layer: it does not enforce the
 * "one owner per workspace" invariant or any role transition rules.
 * Higher-level helpers (`apps/atlasd/src/workspace-authz.ts`) own those.
 */

import { fail, type Result, stringifyError, success } from "@atlas/utils";
import { dec, enc, isCASConflict } from "jetstream";
import { type KV, type NatsConnection, StorageType } from "nats";
import { z } from "zod";

const KV_BUCKET = "WORKSPACE_MEMBERS";

export const RoleSchema = z.enum(["owner", "admin", "member", "agent"]);
export type Role = z.infer<typeof RoleSchema>;

export const WorkspaceMembershipSchema = z.object({
  userId: z.string().min(1),
  wsId: z.string().min(1),
  role: RoleSchema,
  addedAt: z.iso.datetime(),
  /** userId of whoever issued the membership; absent for migration-backfilled rows. */
  addedBy: z.string().min(1).optional(),
});
export type WorkspaceMembership = z.infer<typeof WorkspaceMembershipSchema>;

function memberKey(userId: string, wsId: string): string {
  return `${userId}.${wsId}`;
}

export interface JetStreamWorkspaceMemberBackend {
  /** Read one membership row. */
  get(userId: string, wsId: string): Promise<Result<WorkspaceMembership | null, string>>;
  /** All memberships for a user. Hot path — runs per firehose connect + per HTTP request. */
  listByUser(userId: string): Promise<Result<WorkspaceMembership[], string>>;
  /** All memberships for a workspace. Admin-list path; rare. */
  listByWorkspace(wsId: string): Promise<Result<WorkspaceMembership[], string>>;
  /**
   * Upsert a membership row. Last-write-wins on (userId, wsId).
   * Caller is responsible for invariants (e.g. exactly one owner
   * per workspace).
   */
  put(m: WorkspaceMembership): Promise<Result<WorkspaceMembership, string>>;
  /**
   * Create a row only if absent. Fails with `Result.fail` when the row
   * already exists. Useful for migrations and idempotent backfill.
   */
  putIfAbsent(m: WorkspaceMembership): Promise<Result<WorkspaceMembership | "exists", string>>;
  /** Remove a row. No-op if it doesn't exist. */
  delete(userId: string, wsId: string): Promise<Result<void, string>>;
}

export async function ensureWorkspaceMembersKVBucket(nc: NatsConnection): Promise<KV> {
  const js = nc.jetstream();
  return await js.views.kv(KV_BUCKET, { history: 1, storage: StorageType.File });
}

export function createJetStreamWorkspaceMemberBackend(
  nc: NatsConnection,
): JetStreamWorkspaceMemberBackend {
  let cachedKV: KV | null = null;

  async function kv(): Promise<KV> {
    if (cachedKV) return cachedKV;
    cachedKV = await ensureWorkspaceMembersKVBucket(nc);
    return cachedKV;
  }

  async function readOne(userId: string, wsId: string): Promise<WorkspaceMembership | null> {
    const k = await kv();
    const entry = await k.get(memberKey(userId, wsId));
    if (!entry || entry.operation !== "PUT") return null;
    return WorkspaceMembershipSchema.parse(JSON.parse(dec.decode(entry.value)));
  }

  return {
    async get(userId, wsId) {
      try {
        return success(await readOne(userId, wsId));
      } catch (error) {
        return fail(stringifyError(error));
      }
    },

    async listByUser(userId) {
      try {
        const k = await kv();
        const prefix = `${userId}.`;
        const it = await k.keys();
        const matches: string[] = [];
        for await (const key of it) {
          if (key.startsWith(prefix)) matches.push(key);
        }
        const rows: WorkspaceMembership[] = [];
        for (const key of matches) {
          const entry = await k.get(key);
          if (!entry || entry.operation !== "PUT") continue;
          rows.push(WorkspaceMembershipSchema.parse(JSON.parse(dec.decode(entry.value))));
        }
        return success(rows);
      } catch (error) {
        return fail(stringifyError(error));
      }
    },

    async listByWorkspace(wsId) {
      try {
        const k = await kv();
        const suffix = `.${wsId}`;
        const it = await k.keys();
        const matches: string[] = [];
        for await (const key of it) {
          if (key.endsWith(suffix)) matches.push(key);
        }
        const rows: WorkspaceMembership[] = [];
        for (const key of matches) {
          const entry = await k.get(key);
          if (!entry || entry.operation !== "PUT") continue;
          rows.push(WorkspaceMembershipSchema.parse(JSON.parse(dec.decode(entry.value))));
        }
        return success(rows);
      } catch (error) {
        return fail(stringifyError(error));
      }
    },

    async put(m) {
      try {
        const parsed = WorkspaceMembershipSchema.parse(m);
        const k = await kv();
        await k.put(memberKey(parsed.userId, parsed.wsId), enc.encode(JSON.stringify(parsed)));
        return success(parsed);
      } catch (error) {
        return fail(stringifyError(error));
      }
    },

    async putIfAbsent(m) {
      try {
        const parsed = WorkspaceMembershipSchema.parse(m);
        const k = await kv();
        try {
          await k.create(memberKey(parsed.userId, parsed.wsId), enc.encode(JSON.stringify(parsed)));
          return success(parsed);
        } catch (err) {
          if (isCASConflict(err)) return success("exists");
          throw err;
        }
      } catch (error) {
        return fail(stringifyError(error));
      }
    },

    async delete(userId, wsId) {
      try {
        const k = await kv();
        await k.delete(memberKey(userId, wsId));
        return success(undefined);
      } catch (error) {
        return fail(stringifyError(error));
      }
    },
  };
}
