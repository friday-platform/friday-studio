import { client, parseResult, type InferResponseType } from "@atlas/client/v2";

type SessionsResponse = InferResponseType<typeof client.sessions.index.$get, 200>;

export type SessionInfo = SessionsResponse["sessions"][number];

/**
 * Fetch sessions for a specific workspace.
 */
export async function listWorkspaceSessions(workspaceId: string): Promise<SessionInfo[]> {
  const res = await parseResult(client.sessions.index.$get({ query: { workspaceId } }));

  if (!res.ok) {
    throw new Error(`Failed to load sessions: ${JSON.stringify(res.error)}`);
  }

  return res.data.sessions;
}
