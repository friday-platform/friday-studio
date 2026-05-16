import { redirect } from "@sveltejs/kit";
import type { PageLoad } from "./$types";

const CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/**
 * Generate a short, URL-friendly chat ID.
 * Format: `chat_` prefix + 10 random alphanumeric chars.
 * The prefix makes the ID self-describing (Stripe-style) so you can
 * eyeball a URL and know it’s a chat. 10 chars gives 62^10 (~8e17)
 * collision space — effectively infinite for a single-user playground.
 */
function generateChatId(): string {
  const randomValues = new Uint8Array(10);
  crypto.getRandomValues(randomValues);
  let result = "chat_";
  for (let i = 0; i < 10; i++) {
    result += CHARS[randomValues[i] % CHARS.length];
  }
  return result;
}

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
