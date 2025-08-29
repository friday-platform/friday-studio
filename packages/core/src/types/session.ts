import type { AtlasUIMessage, AtlasUIMessageChunk } from "@atlas/agent-sdk";

type SessionEvents = {
  "session-start": { sessionId: string; signalId: string; workspaceId: string };
  "session-finish": {
    sessionId: string;
    workspaceId: string;
    status?: string;
    duration?: number;
    source?: string;
  };
  "session-cancel": { sessionId: string; workspaceId: string; reason?: string };
  "agent-start": { agentId: string; task: string };
  "agent-finish": { agentId: string; duration: number };
  "agent-error": { agentId: string; duration: number; error: string };
};

export type SessionUIMessage = AtlasUIMessage<SessionEvents>;
export type SessionUIMessageChunk = AtlasUIMessageChunk<SessionEvents>;
