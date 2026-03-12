/** HTTP client for the Ledger resource storage service. Wraps Hono RPC client. */
import process from "node:process";
import type { LedgerApp, ResourceStorageAdapter } from "@atlas/ledger";
import { hc } from "hono/client";

type LedgerClient = ReturnType<typeof hc<LedgerApp>>;

/** Creates a Ledger HTTP client implementing ResourceStorageAdapter. */
export function createLedgerClient(baseUrl?: string): ResourceStorageAdapter {
  const url = baseUrl ?? process.env.LEDGER_URL ?? "http://localhost:3200";
  const atlasKey = process.env.ATLAS_KEY;
  const client: LedgerClient = hc<LedgerApp>(url, {
    headers: atlasKey ? { Authorization: `Bearer ${atlasKey}` } : {},
  });

  return {
    async init(): Promise<void> {
      // No-op for HTTP client — Ledger manages its own initialization.
    },

    async destroy(): Promise<void> {
      // No-op for HTTP client — no connections to clean up.
    },

    async provision(workspaceId, metadata, initialData) {
      const res = await client.v1.resources[":workspaceId"].provision.$post({
        param: { workspaceId },
        json: { ...metadata, initialData },
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Ledger provision failed (${res.status}): ${body}`);
      }
      return await res.json();
    },

    async query(workspaceId, slug, rawSql, params) {
      const res = await client.v1.resources[":workspaceId"][":slug"].query.$post({
        param: { workspaceId, slug },
        json: { sql: rawSql, params },
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Ledger query failed (${res.status}): ${body}`);
      }
      return await res.json();
    },

    async mutate(workspaceId, slug, rawSql, params) {
      const res = await client.v1.resources[":workspaceId"][":slug"].mutate.$post({
        param: { workspaceId, slug },
        json: { sql: rawSql, params },
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Ledger mutate failed (${res.status}): ${body}`);
      }
      return await res.json();
    },

    async publish(workspaceId, slug) {
      const res = await client.v1.resources[":workspaceId"][":slug"].publish.$post({
        param: { workspaceId, slug },
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Ledger publish failed (${res.status}): ${body}`);
      }
      return await res.json();
    },

    async replaceVersion(workspaceId, slug, data, schema) {
      const res = await client.v1.resources[":workspaceId"][":slug"].version.$put({
        param: { workspaceId, slug },
        json: { data, schema },
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Ledger replaceVersion failed (${res.status}): ${body}`);
      }
      return await res.json();
    },

    async listResources(workspaceId) {
      const res = await client.v1.resources[":workspaceId"].$get({ param: { workspaceId } });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Ledger listResources failed (${res.status}): ${body}`);
      }
      return await res.json();
    },

    async getResource(workspaceId, slug, opts) {
      const query: { published?: "true" | "false" } = {};
      if (opts?.published !== undefined) {
        query.published = opts.published ? "true" : "false";
      }
      const res = await client.v1.resources[":workspaceId"][":slug"].$get({
        param: { workspaceId, slug },
        query,
      });
      if (res.status === 404) {
        return null;
      }
      return await res.json();
    },

    async deleteResource(workspaceId, slug) {
      const res = await client.v1.resources[":workspaceId"][":slug"].$delete({
        param: { workspaceId, slug },
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Ledger deleteResource failed (${res.status}): ${body}`);
      }
    },

    async linkRef(workspaceId, slug, ref) {
      const res = await client.v1.resources[":workspaceId"][":slug"]["link-ref"].$post({
        param: { workspaceId, slug },
        json: { ref },
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Ledger linkRef failed (${res.status}): ${body}`);
      }
      return await res.json();
    },

    async resetDraft(workspaceId, slug) {
      const res = await client.v1.resources[":workspaceId"][":slug"]["reset-draft"].$post({
        param: { workspaceId, slug },
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Ledger resetDraft failed (${res.status}): ${body}`);
      }
    },

    async publishAllDirty(workspaceId) {
      const res = await client.v1.resources[":workspaceId"]["publish-all-dirty"].$post({
        param: { workspaceId },
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Ledger publishAllDirty failed (${res.status}): ${body}`);
      }
      const body = await res.json();
      return body.published;
    },

    async getSkill(availableTools?: readonly string[]) {
      const query: { tools?: string } = {};
      if (availableTools) {
        query.tools = availableTools.join(",");
      }
      const res = await client.v1.skill.$get({ query });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Ledger getSkill failed (${res.status}): ${body}`);
      }
      return await res.text();
    },
  };
}
