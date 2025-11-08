import { getContext, setContext } from "svelte";

const KEY = Symbol();

interface SessionTimeline {
  sessionId: string;
  workspaceId: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  summary?: string;
}

class SessionDetailContext {
  session = $state<SessionTimeline | null>(null);

  constructor(session: SessionTimeline) {
    this.session = session;
  }
}

export function setSessionDetailContext(session: SessionTimeline) {
  const ctx = new SessionDetailContext(session);
  return setContext(KEY, ctx);
}

export function getSessionDetailContext() {
  return getContext<ReturnType<typeof setSessionDetailContext>>(KEY);
}
