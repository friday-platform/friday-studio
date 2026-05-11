import { getContext, setContext } from "svelte";

/**
 * Workspace id the current chat surface is rendering under. Set once
 * by the chat parent component (user-chat.svelte) and read by deeper
 * descendants (ArtifactCard, table-action handlers) that need to build
 * in-app routes like `/platform/<wsId>/table/<artifactId>` without
 * prop-drilling through the intermediate components.
 *
 * Lives in a dedicated context (rather than reading from `$app/state`)
 * so component tests can render without a real SvelteKit page-data
 * environment — the chat-replay tool also reuses these components
 * outside the workspace route, and the export-mode static HTML path
 * has no router at all. Providers wire workspaceId explicitly; bare
 * components fall back to `undefined` (any feature that needs the id
 * — e.g. the ArtifactCard's tabular-Open link — gracefully degrades).
 */
const CHAT_WORKSPACE_CONTEXT_KEY: unique symbol = Symbol("atlas.chat.workspace");

export function setChatWorkspaceContext(workspaceId: string): void {
  setContext(CHAT_WORKSPACE_CONTEXT_KEY, workspaceId);
}

export function getChatWorkspaceContext(): string | undefined {
  return getContext<string | undefined>(CHAT_WORKSPACE_CONTEXT_KEY);
}
