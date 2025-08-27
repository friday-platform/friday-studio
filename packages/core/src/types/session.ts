import type { AtlasUIMessage, AtlasUIMessageChunk } from "@atlas/agent-sdk";

type SessionEvents = {
  "session-start": { sessionId: string; signalId: string; workspaceId: string };
  "session-finish": { sessionId: string; workspaceId: string };
  "agent-start": { agentId: string; task: string };
  "agent-finish": { agentId: string; duration: number };
  "agent-error": { agentId: string; duration: number; error: string };
};

export type SessionUIMessage = AtlasUIMessage<SessionEvents>;
export type SessionUIMessageChunk = AtlasUIMessageChunk<SessionEvents>;
