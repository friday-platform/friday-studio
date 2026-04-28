/**
 * Query option factory and mutations for communicator wiring + Slack
 * connect/disconnect orchestration.
 *
 * Co-locates query key + queryFn + shared config per TKDodo's queryOptions pattern.
 *
 * @module
 */
import { createMutation, queryOptions, skipToken, useQueryClient } from "@tanstack/svelte-query";
import { z } from "zod";
import { getDaemonClient } from "../daemon-client.ts";
import { integrationQueries } from "./integration-queries.ts";

// ==============================================================================
// SCHEMAS & TYPES
// ==============================================================================

const WiringResponseSchema = z.object({
  wiring: z
    .object({ credential_id: z.string(), connection_id: z.string().nullable() })
    .nullable(),
});

/** Per-workspace wiring state for one communicator provider. */
export type WorkspaceWiring = z.infer<typeof WiringResponseSchema>["wiring"];

const ConnectSlackResponseSchema = z.union([
  z.object({ ok: z.literal(true), alreadyConnected: z.literal(true), app_id: z.string().optional() }),
  z.object({ ok: z.literal(true), installRequired: z.literal(true) }),
  z.object({ ok: z.literal(true), app_id: z.string().optional() }),
]);

/** Discriminated outcome of a connect-slack POST. */
export type ConnectSlackResponse = z.infer<typeof ConnectSlackResponseSchema>;

// ==============================================================================
// QUERY FACTORY
// ==============================================================================

export const wiringQueries = {
  /** Key-only entry for hierarchical invalidation of all wiring queries. */
  all: () => ["daemon", "link", "wiring"] as const,

  /**
   * Wiring state for `(workspaceId, provider)`. Server returns
   * `{ wiring: null }` for unwired and `{ wiring: {...} }` when wired —
   * both are 200, so a real 404 means infra failure, not "not connected".
   */
  workspace: (workspaceId: string | null, provider: string) =>
    queryOptions({
      queryKey: ["daemon", "link", "wiring", workspaceId, provider] as const,
      queryFn: workspaceId
        ? async (): Promise<WorkspaceWiring> => {
            const url = new URL(
              "/api/daemon/api/link/internal/v1/communicator/wiring",
              globalThis.location?.origin ?? "http://localhost",
            );
            url.searchParams.set("workspace_id", workspaceId);
            url.searchParams.set("provider", provider);

            const res = await fetch(url.toString());
            if (!res.ok) throw new Error(`Wiring lookup failed: ${res.status}`);
            const data: unknown = await res.json();
            return WiringResponseSchema.parse(data).wiring;
          }
        : skipToken,
      staleTime: 30_000,
      retry: false,
    }),
};

// ==============================================================================
// MUTATIONS
// ==============================================================================

/**
 * POST /api/daemon/workspaces/{id}/connect-slack with optional credential_id.
 *
 * Empty body probes wiring state — returns `installRequired` if no credential
 * is wired yet. Passing `credential_id` (after a successful OAuth) wires the
 * credential to the workspace.
 */
export function useConnectSlack() {
  const queryClient = useQueryClient();

  return createMutation(() => ({
    mutationFn: async (
      input: { workspaceId: string; credentialId?: string },
    ): Promise<ConnectSlackResponse> => {
      const client = getDaemonClient();
      const res = await client.workspace[":workspaceId"]["connect-slack"].$post({
        param: { workspaceId: input.workspaceId },
        json: input.credentialId ? { credential_id: input.credentialId } : {},
      });
      const body: unknown = await res.json().catch(() => ({}));
      if (!res.ok) {
        const errMsg =
          typeof body === "object" && body !== null && "error" in body
            ? String(body.error)
            : `Connect Slack failed: ${res.status}`;
        throw new Error(errMsg);
      }
      return ConnectSlackResponseSchema.parse(body);
    },
    onSuccess: (_data, input) => {
      queryClient.invalidateQueries({ queryKey: wiringQueries.all() });
      queryClient.invalidateQueries({
        queryKey: integrationQueries.preflight(input.workspaceId).queryKey,
      });
    },
  }));
}

/** POST /api/daemon/workspaces/{id}/disconnect-slack. */
export function useDisconnectSlack() {
  const queryClient = useQueryClient();

  return createMutation(() => ({
    mutationFn: async (input: { workspaceId: string }): Promise<void> => {
      const client = getDaemonClient();
      const res = await client.workspace[":workspaceId"]["disconnect-slack"].$post({
        param: { workspaceId: input.workspaceId },
      });
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => ({}));
        const errMsg =
          typeof body === "object" && body !== null && "error" in body
            ? String(body.error)
            : `Disconnect Slack failed: ${res.status}`;
        throw new Error(errMsg);
      }
    },
    onSuccess: (_data, input) => {
      queryClient.invalidateQueries({ queryKey: wiringQueries.all() });
      queryClient.invalidateQueries({
        queryKey: integrationQueries.preflight(input.workspaceId).queryKey,
      });
    },
  }));
}

const ConnectCommunicatorResponseSchema = z.object({
  ok: z.literal(true),
  kind: z.string(),
});

const DisconnectCommunicatorResponseSchema = z.object({
  ok: z.literal(true),
  credential_id: z.string().nullable(),
});

/**
 * Generic communicator wire mutation — POSTs to atlasd's
 * `/workspaces/{id}/connect-communicator`. atlasd handles the Link wire +
 * yml mutation + chat-sdk eviction atomically; the playground passes only
 * `kind` and `credential_id`. `connection_id` derivation lives server-side.
 *
 * Used for non-Slack apikey communicators (telegram, etc). Slack uses its
 * own `useConnectSlack` because of the app-install popup orchestration.
 *
 * `kind` flows through `mutate()` rather than the hook factory because
 * Svelte forbids calling hooks inside `{#each}` — one hook per card serves
 * all rows.
 */
export function useConnectCommunicator() {
  const queryClient = useQueryClient();

  return createMutation(() => ({
    mutationFn: async (input: {
      workspaceId: string;
      kind: string;
      credentialId: string;
    }): Promise<void> => {
      const url = `/api/daemon/api/workspaces/${encodeURIComponent(input.workspaceId)}/connect-communicator`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: input.kind, credential_id: input.credentialId }),
      });

      if (!res.ok) {
        const body: unknown = await res.json().catch(() => ({}));
        const errMsg =
          typeof body === "object" && body !== null && "error" in body
            ? String(body.error)
            : `Connect ${input.kind} failed: ${res.status}`;
        throw new Error(errMsg);
      }

      ConnectCommunicatorResponseSchema.parse(await res.json());
    },
    onSuccess: (_data, input) => {
      queryClient.invalidateQueries({ queryKey: wiringQueries.all() });
      queryClient.invalidateQueries({
        queryKey: integrationQueries.preflight(input.workspaceId).queryKey,
      });
    },
  }));
}

/**
 * Generic communicator disconnect mutation — POSTs to atlasd's
 * `/workspaces/{id}/disconnect-communicator`. atlasd removes the yml block,
 * deletes the Link wiring, and evicts chat-sdk. Returns the deleted
 * wiring's credential_id (or null when no wiring existed); we discard it
 * since the card only cares about the wiring being gone.
 */
export function useDisconnectCommunicator() {
  const queryClient = useQueryClient();

  return createMutation(() => ({
    mutationFn: async (input: { workspaceId: string; kind: string }): Promise<void> => {
      const url = `/api/daemon/api/workspaces/${encodeURIComponent(input.workspaceId)}/disconnect-communicator`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: input.kind }),
      });

      if (!res.ok) {
        const body: unknown = await res.json().catch(() => ({}));
        const errMsg =
          typeof body === "object" && body !== null && "error" in body
            ? String(body.error)
            : `Disconnect ${input.kind} failed: ${res.status}`;
        throw new Error(errMsg);
      }

      DisconnectCommunicatorResponseSchema.parse(await res.json());
    },
    onSuccess: (_data, input) => {
      queryClient.invalidateQueries({ queryKey: wiringQueries.all() });
      queryClient.invalidateQueries({
        queryKey: integrationQueries.preflight(input.workspaceId).queryKey,
      });
    },
  }));
}
