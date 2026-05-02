import { error } from "@sveltejs/kit";
import type { PageLoad } from "./$types";

/**
 * Debug view for a chat. Server load fetches:
 *   - the chat from the daemon (JetStream-backed)
 *   - any sub-sessions referenced by tool-call outputs (sessionId field)
 *
 * Sub-session fetching is best-effort: a 404 just means the session has
 * already aged out of the registry / adapter. Render whatever we got.
 */
export const load: PageLoad = async ({ params, fetch }) => {
  const workspaceId = params.workspaceId;
  const chatId = params.chatId;
  if (!workspaceId || !chatId) {
    throw error(400, "Missing workspaceId or chatId");
  }

  const chatUrl = `/api/daemon/api/workspaces/${encodeURIComponent(workspaceId)}/chat/${encodeURIComponent(chatId)}`;
  const chatRes = await fetch(chatUrl);
  if (!chatRes.ok) {
    throw error(chatRes.status, `Failed to fetch chat: ${chatRes.status}`);
  }
  const chatBody = (await chatRes.json()) as {
    chat: { id: string; workspaceId: string; title?: string; createdAt: string; updatedAt: string };
    messages: Array<{
      id: string;
      role: "user" | "assistant" | "system";
      metadata?: Record<string, unknown>;
      parts: Array<Record<string, unknown>>;
    }>;
  };

  // Collect sub-session IDs referenced from tool outputs.
  const sessionIds = new Set<string>();
  for (const m of chatBody.messages) {
    for (const p of m.parts) {
      const out = p.output as Record<string, unknown> | undefined;
      const sid = out && typeof out.sessionId === "string" ? out.sessionId : null;
      if (sid) sessionIds.add(sid);
    }
  }

  // Fetch each session view in parallel. Failures don't abort the page.
  const sessionEntries = await Promise.all(
    [...sessionIds].map(async (id) => {
      try {
        const r = await fetch(`/api/daemon/api/sessions/${encodeURIComponent(id)}`);
        if (!r.ok) return [id, { error: `${r.status} ${r.statusText}` }] as const;
        return [id, await r.json()] as const;
      } catch (e) {
        return [id, { error: e instanceof Error ? e.message : String(e) }] as const;
      }
    }),
  );
  const sessions = Object.fromEntries(sessionEntries);

  return { chat: chatBody.chat, messages: chatBody.messages, sessions, workspaceId };
};
