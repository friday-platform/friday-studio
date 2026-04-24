/**
 * MCP registry mutations and types.
 *
 * Query hooks have been replaced by `mcpQueries` factories in `mcp-queries.ts`.
 * Mutations for MCP registry operations remain here.
 *
 * @module
 */
import { MCPServerMetadataSchema } from "@atlas/core/mcp-registry/schemas";
import { createMutation, useQueryClient } from "@tanstack/svelte-query";
import { z } from "zod";
import { getDaemonClient } from "../daemon-client.ts";
import { mcpQueries } from "./mcp-queries.ts";

// ==============================================================================
// SCHEMAS & TYPES
// ==============================================================================

const InstallResponseSchema = z.object({ server: MCPServerMetadataSchema });

const InstallErrorSchema = z.object({
  error: z.string(),
  suggestion: z.string().optional(),
  existingId: z.string().optional(),
});

const CheckUpdateResponseSchema = z.object({
  hasUpdate: z.boolean(),
  reason: z.string().optional(),
  remote: z.object({ updatedAt: z.string(), version: z.string() }).optional(),
});

const PullUpdateResponseSchema = z.object({ server: MCPServerMetadataSchema });

const DeleteErrorSchema = z.object({ error: z.string() });

export interface InstallMCPInput {
  registryName: string;
}

// ==============================================================================
// MUTATION HOOKS
// ==============================================================================

/**
 * Mutation for installing an MCP server from the registry.
 * Wraps `POST /api/mcp-registry/install` via daemon client.
 * Invalidates catalog query on success.
 * Parses error response and throws with message for UI toast display.
 */
export function useInstallMCPServer() {
  const client = getDaemonClient();
  const queryClient = useQueryClient();

  return createMutation(() => ({
    mutationFn: async (input: InstallMCPInput) => {
      const res = await client.mcp.install.$post({ json: { registryName: input.registryName } });
      const body = await res.json();

      if (!res.ok) {
        const parsed = InstallErrorSchema.safeParse(body);
        const msg = parsed.success ? parsed.data.error : `Install failed: ${res.status}`;
        throw new Error(msg);
      }

      return InstallResponseSchema.parse(body);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: mcpQueries.all() });
    },
  }));
}

/**
 * Mutation for checking if an MCP server has an available update.
 * Wraps `GET /api/mcp-registry/:id/check-update` via daemon client.
 * Takes the server ID as a mutation variable so one instance can service
 * any registry-imported entry.
 */
export function useCheckMCPUpdate() {
  const client = getDaemonClient();

  return createMutation(() => ({
    mutationFn: async (id: string) => {
      const res = await client.mcp[":id"]["check-update"].$get({ param: { id } });
      if (!res.ok) throw new Error(`Failed to check for update: ${res.status}`);
      return CheckUpdateResponseSchema.parse(await res.json());
    },
  }));
}

/**
 * Mutation for pulling an update for an MCP server.
 * Wraps `POST /api/mcp-registry/:id/update` via daemon client.
 * Invalidates catalog and detail queries on success.
 * Takes the server ID as a mutation variable so one instance can service
 * any registry-imported entry.
 */
export function usePullMCPUpdate() {
  const client = getDaemonClient();
  const queryClient = useQueryClient();

  return createMutation(() => ({
    mutationFn: async (id: string) => {
      const res = await client.mcp[":id"].update.$post({ param: { id } });
      if (!res.ok) throw new Error(`Failed to pull update: ${res.status}`);
      return PullUpdateResponseSchema.parse(await res.json());
    },
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: mcpQueries.all() });
      queryClient.invalidateQueries({ queryKey: mcpQueries.detail(id).queryKey });
    },
  }));
}

/**
 * Mutation for deleting an MCP registry entry.
 * Wraps `DELETE /api/mcp-registry/:id` via daemon client.
 * Invalidates catalog query on success.
 * Built-in (static) entries are rejected by the server with 403.
 */
export function useDeleteMCPServer() {
  const client = getDaemonClient();
  const queryClient = useQueryClient();

  return createMutation(() => ({
    mutationFn: async (id: string) => {
      const res = await client.mcp[":id"].$delete({ param: { id } });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const parsed = DeleteErrorSchema.safeParse(body);
        const msg = parsed.success ? parsed.data.error : `Delete failed: ${res.status}`;
        throw new Error(msg);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: mcpQueries.all() });
    },
  }));
}
