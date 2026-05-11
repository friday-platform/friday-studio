import { error } from "@sveltejs/kit";
import type { PageLoad } from "./$types";

type ChatBody = {
  chat: {
    id: string;
    workspaceId: string;
    title?: string;
    createdAt: string;
    updatedAt: string;
    systemPromptContext?: { timestamp: string; systemMessages: string[] } | null;
  };
  messages: Array<{
    id: string;
    role: "user" | "assistant" | "system";
    metadata?: Record<string, unknown>;
    parts: Array<Record<string, unknown>>;
  }>;
  systemPromptContext?: { timestamp: string; systemMessages: string[] } | null;
};

type ChatDebugBody = {
  activeStream?: {
    events?: unknown[];
  };
};

function collectSessionIdsFromChunk(value: unknown, out: Set<string>): void {
  if (typeof value !== "object" || value === null || !("type" in value)) return;
  const chunk = value as Record<string, unknown>;
  const data = chunk.data;
  if (typeof data === "object" && data !== null) {
    const d = data as Record<string, unknown>;
    if (typeof d.sessionId === "string") out.add(d.sessionId);
    if ("chunk" in d) collectSessionIdsFromChunk(d.chunk, out);
  }
}

/**
 * Debug view for a chat. Server load fetches:
 *   - the chat from the daemon (JetStream-backed)
 *   - any sub-sessions referenced by tool-call outputs (sessionId field)
 *
 * Sub-session fetching is best-effort: a 404 just means the session has
 * already aged out of the registry / adapter. Render whatever we got.
 *
 * Chat fetch tolerates 404 too — the regular chat page lazily creates a
 * chat on first message, so a debug URL for an unused chatId is normal.
 * Surface "no chat in storage" rather than bouncing to a SvelteKit error.
 */
export const load: PageLoad = async ({ params, fetch }) => {
  const workspaceId = params.workspaceId;
  const chatId = params.chatId;
  if (!workspaceId || !chatId) {
    throw error(400, "Missing workspaceId or chatId");
  }

  const chatUrl = `/api/daemon/api/workspaces/${encodeURIComponent(workspaceId)}/chat/${encodeURIComponent(chatId)}`;
  const chatRes = await fetch(chatUrl);

  let chatBody: ChatBody | null = null;
  let fetchError: string | null = null;
  if (chatRes.status === 404) {
    fetchError = "chat not found in storage (probably never received a message)";
  } else if (!chatRes.ok) {
    throw error(chatRes.status, `Failed to fetch chat: ${chatRes.status}`);
  } else {
    chatBody = (await chatRes.json()) as ChatBody;
  }

  const messages = chatBody?.messages ?? [];

  // JetStream + KV inspection for the chat — useful when investigating
  // "where did this chat go" or "why isn't this message persisted" bugs.
  // Read-only, best-effort: failures here don't abort the page.
  let nats: unknown = null;
  try {
    const debugUrl = `/api/daemon/api/workspaces/${encodeURIComponent(workspaceId)}/chat/${encodeURIComponent(chatId)}/_debug`;
    const r = await fetch(debugUrl);
    if (r.ok) {
      nats = await r.json();
    } else {
      nats = { error: `${r.status} ${r.statusText}` };
    }
  } catch (e) {
    nats = { error: e instanceof Error ? e.message : String(e) };
  }

  // Collect sub-session IDs referenced from completed tool outputs and from
  // the active stream snapshot. HITL-blocked chat tools have not produced a
  // terminal `output.sessionId` yet, so the active stream is the only source
  // for the nested job session while the question is pending.
  const sessionIds = new Set<string>();
  for (const m of messages) {
    for (const p of m.parts) {
      const out = p.output as Record<string, unknown> | undefined;
      const sid = out && typeof out.sessionId === "string" ? out.sessionId : null;
      if (sid) sessionIds.add(sid);
    }
  }
  const activeEvents = (nats as ChatDebugBody | null)?.activeStream?.events ?? [];
  for (const event of activeEvents) collectSessionIdsFromChunk(event, sessionIds);

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

  // The systemPromptContext lives on the chat record (top-level for newer
  // shapes; nested under `chat` for older ones). Surface either spelling
  // so the /debug view renders the captured cache blocks regardless.
  const systemPromptContext =
    chatBody?.systemPromptContext ?? chatBody?.chat?.systemPromptContext ?? null;

  return {
    chatId,
    workspaceId,
    chat: chatBody?.chat ?? null,
    messages,
    sessions,
    nats,
    systemPromptContext,
    fetchError,
  };
};
