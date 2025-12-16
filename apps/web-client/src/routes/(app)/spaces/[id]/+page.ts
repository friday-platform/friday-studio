import { client, parseResult } from "@atlas/client/v2";
import { error } from "@sveltejs/kit";
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ params }) => {
  const [sessionsRes, artifactsRes] = await Promise.all([
    parseResult(client.sessionHistory.index.$get({ query: { workspaceId: params.id } })),
    parseResult(
      client.artifactsStorage.index.$get({ query: { workspaceId: params.id, limit: 10 } }),
    ),
  ]);

  if (!sessionsRes.ok) {
    error(500, `Failed to load workspace sessions: ${JSON.stringify(sessionsRes.error)}`);
  }

  return {
    sessions: sessionsRes.data.sessions,
    artifacts: artifactsRes.ok ? artifactsRes.data.artifacts : [],
  };
};
