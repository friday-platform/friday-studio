import { generateChatId } from "@atlas/core/chat/id";
import { redirect } from "@sveltejs/kit";
import type { PageLoad } from "./$types";

/**
 * Resolves the bootstrap setup session for a workspace, when one exists.
 * Returns null on any failure — callers fall back to generating a fresh
 * chat id rather than blocking the user on a daemon hiccup.
 */
async function loadBootstrapSessionId(
  fetch: typeof globalThis.fetch,
  workspaceId: string,
): Promise<string | null> {
  try {
    const res = await fetch(`/api/daemon/api/workspaces/${encodeURIComponent(workspaceId)}`);
    if (!res.ok) return null;
    const body = (await res.json()) as { metadata?: { active_setup_session_id?: string | null } };
    return body.metadata?.active_setup_session_id ?? null;
  } catch {
    return null;
  }
}

export const load: PageLoad = async ({ params, fetch }) => {
  const wsId = params.workspaceId ?? "user";
  const chatId = params.chatId;

  if (!chatId) {
    const bootstrapId = await loadBootstrapSessionId(fetch, wsId);
    const next = bootstrapId ?? generateChatId();
    throw redirect(302, `/platform/${encodeURIComponent(wsId)}/chat/${next}`);
  }

  return { chatId };
};
