import type { AtlasTools } from "@atlas/agent-sdk";
import { client, parseResult } from "@atlas/client/v2";
import type { WorkspaceConfig } from "@atlas/config";
import {
  composeArtifactBlocks,
  composeMemoryBlocks,
} from "@atlas/core/agent-context/compose-blocks";
import type { Logger } from "@atlas/logger";

// Re-export so existing chat-side imports keep working unchanged.
// The canonical implementation now lives in @atlas/core so the FSM
// engine can consume it without crossing the chat-package layering
// boundary. See `packages/core/src/agent-context/compose-blocks.ts`.
export { composeArtifactBlocks, composeMemoryBlocks };

/**
 * Foreground workspace context. The primary system prompt no longer carries
 * the foreground's full `<workspace>` block — instead, the foreground id
 * is surfaced as a names-only `<foreground_workspaces>` tag and the chat
 * fetches `describe_workspace(id)` on demand.
 *
 * The config is still loaded eagerly because foreground job/signal tools
 * are bound at handler-build time (the LLM needs them in its callable
 * tool set, not as runtime-resolved descriptors).
 */
export interface ComposedForegroundContext {
  workspaceId: string;
  config?: WorkspaceConfig;
}

/**
 * Resolve foreground workspace contexts to their configs. Configs feed
 * job-tool binding; everything else (workspace details, skills) the chat
 * pulls per-turn via retrieval tools.
 */
export async function fetchForegroundContexts(
  foregroundIds: string[],
  logger: Logger,
): Promise<ComposedForegroundContext[]> {
  const results = await Promise.allSettled(
    foregroundIds.map(async (workspaceId) => {
      const cfgResult = await parseResult(
        client.workspace[":workspaceId"].config.$get({ param: { workspaceId } }),
      );
      const config = cfgResult.ok
        ? (cfgResult.data as { config?: WorkspaceConfig }).config
        : undefined;
      if (!cfgResult.ok) {
        logger.warn("fetchForegroundContexts: config fetch failed", {
          workspaceId,
          error: cfgResult.error,
        });
      }
      return { workspaceId, config };
    }),
  );

  const contexts: ComposedForegroundContext[] = [];
  for (const [i, result] of results.entries()) {
    if (result.status === "fulfilled") {
      contexts.push(result.value);
    } else {
      logger.warn("Failed to fetch foreground workspace context", {
        workspaceId: foregroundIds[i],
        error: result.reason,
      });
    }
  }
  return contexts;
}

/**
 * Append a names-only `<foreground_workspaces>` tag to the primary
 * workspace section. The chat retrieves details via `describe_workspace(id)`
 * when needed, instead of inlining the full `<workspace>` block per
 * foreground.
 */
export function composeWorkspaceSections(
  primarySection: string,
  foregrounds: ComposedForegroundContext[],
): string {
  if (foregrounds.length === 0) return primarySection;
  const ids = foregrounds.map((fg) => fg.workspaceId).join(", ");
  return `${primarySection}\n\n<foreground_workspaces>${ids}</foreground_workspaces>`;
}

/**
 * Compose the chat's tool set with foreground job tools. Primary wins on
 * name conflict — a job in the primary workspace shadows a same-named job
 * in a foreground.
 */
export function composeTools(
  primaryTools: AtlasTools,
  foregroundToolSets: Array<{ workspaceId: string; tools: AtlasTools }>,
): AtlasTools {
  if (foregroundToolSets.length === 0) return primaryTools;

  const merged: AtlasTools = { ...primaryTools };
  for (const { tools } of foregroundToolSets) {
    for (const [name, tool] of Object.entries(tools)) {
      if (!(name in merged)) {
        merged[name] = tool;
      }
    }
  }
  return merged;
}
