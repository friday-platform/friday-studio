/**
 * Query option factories and mutations for workspace-scoped MCP operations.
 *
 * Co-locates query key + queryFn + shared config per TKDodo's queryOptions pattern,
 * plus mutation hooks for enable/disable and an SSE stream utility for test-chat.
 *
 * @module
 */
import { MCPSourceSchema } from "@atlas/core/mcp-registry/schemas";
import { createMutation, queryOptions, skipToken, useQueryClient } from "@tanstack/svelte-query";
import { z } from "zod";
import { getDaemonClient } from "../daemon-client.ts";
import { parseSSEStream } from "@atlas/utils/sse";

// ==============================================================================
// SCHEMAS & TYPES
// ==============================================================================

const EnrichedMCPServerSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  source: MCPSourceSchema,
  configured: z.boolean(),
  agentIds: z.array(z.string()).optional(),
  jobIds: z.array(z.string()).optional(),
});

export type EnrichedMCPServer = z.infer<typeof EnrichedMCPServerSchema>;

const WorkspaceMCPStatusSchema = z.object({
  enabled: z.array(EnrichedMCPServerSchema),
  available: z.array(EnrichedMCPServerSchema),
});

export type WorkspaceMCPStatus = z.infer<typeof WorkspaceMCPStatusSchema>;

const EnableResponseSchema = z.object({
  server: z.object({ id: z.string(), name: z.string() }),
});

const DisableResponseSchema = z.object({
  removed: z.string(),
});

const ErrorResponseSchema = z.object({
  success: z.boolean().optional(),
  error: z.string(),
  message: z.string().optional(),
  willUnlinkFrom: z.array(z.record(z.string(), z.unknown())).optional(),
});

/** A single parsed test-chat SSE event. */
export type TestChatEvent =
  | { type: "chunk"; text: string }
  | { type: "tool_call"; toolCallId: string; toolName: string; input: unknown }
  | { type: "tool_result"; toolCallId: string; output: unknown }
  | { type: "done" }
  | { type: "error"; error: string; phase?: "dns" | "connect" | "auth" | "tools" };

// ==============================================================================
// QUERY FACTORIES
// ==============================================================================

export const workspaceMcpQueries = {
  /** Key-only entry for hierarchical invalidation of all workspace MCP queries. */
  all: (workspaceId: string) => ["daemon", "workspace", workspaceId, "mcp"] as const,

  /** Workspace MCP status: enabled vs available server partition. */
  status: (workspaceId: string | null) =>
    queryOptions({
      queryKey: workspaceId
        ? (["daemon", "workspace", workspaceId, "mcp", "status"] as const)
        : (["daemon", "workspace", "mcp", "status"] as const),
      queryFn: workspaceId
        ? async (): Promise<WorkspaceMCPStatus> => {
            const client = getDaemonClient();
            const res = await client.workspaceMcp(workspaceId).index.$get();
            if (!res.ok) throw new Error(`Failed to fetch workspace MCP status: ${res.status}`);
            return WorkspaceMCPStatusSchema.parse(await res.json());
          }
        : skipToken,
      staleTime: 30_000,
    }),
};

// ==============================================================================
// MUTATION HOOKS
// ==============================================================================

/**
 * Mutation for enabling an MCP server in a workspace.
 * Wraps `PUT /api/workspaces/:workspaceId/mcp/:serverId` via daemon client.
 * Invalidates workspace MCP status query on success.
 */
export function useEnableMCPServer() {
  const queryClient = useQueryClient();

  return createMutation(() => ({
    mutationFn: async (input: { workspaceId: string; serverId: string }) => {
      const client = getDaemonClient();
      const res = await client.workspaceMcp(input.workspaceId)[":serverId"].$put({
        param: { serverId: input.serverId },
      });
      const body: unknown = await res.json().catch(() => ({}));
      if (!res.ok) {
        const parsed = ErrorResponseSchema.safeParse(body);
        const msg = parsed.success
          ? (parsed.data.message ?? parsed.data.error)
          : `Enable failed: ${res.status}`;
        throw new Error(msg);
      }
      return EnableResponseSchema.parse(body);
    },
    onSuccess: (_data, input) => {
      queryClient.invalidateQueries({ queryKey: workspaceMcpQueries.all(input.workspaceId) });
    },
  }));
}

/**
 * Mutation for disabling an MCP server in a workspace.
 * Wraps `DELETE /api/workspaces/:workspaceId/mcp/:serverId?force=...` via daemon client.
 * Invalidates workspace MCP status query on success.
 */
export function useDisableMCPServer() {
  const queryClient = useQueryClient();

  return createMutation(() => ({
    mutationFn: async (input: { workspaceId: string; serverId: string; force?: boolean }) => {
      const client = getDaemonClient();
      const res = await client.workspaceMcp(input.workspaceId)[":serverId"].$delete({
        param: { serverId: input.serverId },
        query: input.force ? { force: "true" as const } : {},
      });
      const body: unknown = await res.json().catch(() => ({}));
      if (!res.ok) {
        const parsed = ErrorResponseSchema.safeParse(body);
        const msg = parsed.success
          ? (parsed.data.message ?? parsed.data.error)
          : `Disable failed: ${res.status}`;
        throw new Error(msg);
      }
      return DisableResponseSchema.parse(body);
    },
    onSuccess: (_data, input) => {
      queryClient.invalidateQueries({ queryKey: workspaceMcpQueries.all(input.workspaceId) });
    },
  }));
}

// ==============================================================================
// TEST-CHAT SSE STREAM
// ==============================================================================

/**
 * Async generator that consumes the MCP test-chat SSE endpoint (via proxy)
 * and yields parsed {@link TestChatEvent} objects.
 *
 * @param serverId - The MCP server ID to test
 * @param message - The user message to send
 * @param workspaceId - Optional workspace ID for workspace-scoped credential resolution
 * @yields Parsed test-chat events (chunk, tool_call, tool_result, done, error)
 */
export async function* testChatEventStream(
  serverId: string,
  message: string,
  workspaceId?: string,
): AsyncGenerator<TestChatEvent> {
  const url = new URL(
    `/api/daemon/api/mcp-registry/${encodeURIComponent(serverId)}/test-chat`,
    globalThis.location?.origin ?? "http://localhost",
  );
  if (workspaceId) {
    url.searchParams.set("workspaceId", workspaceId);
  }

  const response = await fetch(url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify({ message }),
  });

  if (!response.ok) {
    const body: unknown = await response.json().catch(() => ({}));
    const msg =
      typeof body === "object" && body !== null && "error" in body
        ? String((body as { error: unknown }).error)
        : `Test chat failed: ${response.status}`;
    throw new Error(msg);
  }

  if (!response.body) {
    throw new Error("Test chat response has no body");
  }

  for await (const message of parseSSEStream(response.body)) {
    let data: unknown;
    try {
      data = JSON.parse(message.data);
    } catch {
      continue;
    }

    switch (message.event) {
      case "chunk": {
        const parsed = z.object({ text: z.string() }).safeParse(data);
        if (parsed.success) yield { type: "chunk", text: parsed.data.text };
        break;
      }
      case "tool_call": {
        const parsed = z
          .object({
            toolCallId: z.string(),
            toolName: z.string(),
            input: z.unknown(),
          })
          .safeParse(data);
        if (parsed.success) {
          yield {
            type: "tool_call",
            toolCallId: parsed.data.toolCallId,
            toolName: parsed.data.toolName,
            input: parsed.data.input,
          };
        }
        break;
      }
      case "tool_result": {
        const parsed = z
          .object({
            toolCallId: z.string(),
            output: z.unknown(),
          })
          .safeParse(data);
        if (parsed.success) {
          yield {
            type: "tool_result",
            toolCallId: parsed.data.toolCallId,
            output: parsed.data.output,
          };
        }
        break;
      }
      case "done":
        yield { type: "done" };
        break;
      case "error": {
        const parsed = z
          .object({
            error: z.string(),
            phase: z.enum(["dns", "connect", "auth", "tools"]).optional(),
          })
          .safeParse(data);
        if (parsed.success) {
          yield {
            type: "error",
            error: parsed.data.error,
            phase: parsed.data.phase,
          };
        }
        break;
      }
    }
  }
}
