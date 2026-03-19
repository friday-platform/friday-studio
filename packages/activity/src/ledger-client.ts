/** HTTP client for the Ledger activity storage service. Wraps Hono RPC client. */
import process from "node:process";
import type { LedgerApp } from "@atlas/ledger";
import { hc } from "hono/client";
import type { Activity, CreateActivityInput, ReadStatusValue } from "./schemas.ts";
import type { ActivityListResult, ActivityStorageAdapter } from "./storage.ts";

type LedgerClient = ReturnType<typeof hc<LedgerApp>>;

/** Creates a Ledger HTTP client implementing ActivityStorageAdapter. */
export function createActivityLedgerClient(baseUrl?: string): ActivityStorageAdapter {
  const url = baseUrl ?? process.env.LEDGER_URL ?? "http://localhost:3200";
  const atlasKey = process.env.ATLAS_KEY;
  const client: LedgerClient = hc<LedgerApp>(url, {
    headers: atlasKey ? { Authorization: `Bearer ${atlasKey}` } : {},
  });

  return {
    async create(input: CreateActivityInput): Promise<Activity> {
      const res = await client.v1.activity.$post({ json: input });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Ledger activity create failed (${res.status}): ${body}`);
      }
      return await res.json();
    },

    async deleteByReferenceId(referenceId: string): Promise<void> {
      const res = await client.v1.activity["by-reference"][":referenceId"].$delete({
        param: { referenceId },
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Ledger activity deleteByReferenceId failed (${res.status}): ${body}`);
      }
    },

    async list(_userId: string, filters?): Promise<ActivityListResult> {
      const query: Record<string, string> = {};
      if (filters?.type) query.type = filters.type;
      if (filters?.workspaceId) query.workspaceId = filters.workspaceId;
      if (filters?.after) query.after = filters.after;
      if (filters?.before) query.before = filters.before;
      if (filters?.limit !== undefined) query.limit = String(filters.limit);
      if (filters?.offset !== undefined) query.offset = String(filters.offset);

      const res = await client.v1.activity.$get({ query });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Ledger activity list failed (${res.status}): ${body}`);
      }
      return await res.json();
    },

    async getUnreadCount(_userId: string): Promise<number> {
      const res = await client.v1.activity["unread-count"].$get();
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Ledger activity getUnreadCount failed (${res.status}): ${body}`);
      }
      const data = await res.json();
      return data.count;
    },

    async updateReadStatus(
      _userId: string,
      activityIds: string[],
      status: ReadStatusValue,
    ): Promise<void> {
      const res = await client.v1.activity.mark.$post({ json: { activityIds, status } });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Ledger activity updateReadStatus failed (${res.status}): ${body}`);
      }
    },

    async markViewedBefore(_userId: string, before: string): Promise<void> {
      const res = await client.v1.activity.mark.$post({
        json: { before, status: "viewed" as const },
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Ledger activity markViewedBefore failed (${res.status}): ${body}`);
      }
    },
  };
}
