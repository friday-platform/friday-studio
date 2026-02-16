import { client, parseResult } from "@atlas/client/v2";
import { error } from "@sveltejs/kit";
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ params }) => {
  const res = await parseResult(
    client.sessions.index.$get({ query: { workspaceId: params.spaceId } }),
  );

  if (!res.ok) {
    error(500, `Failed to load workspace sessions: ${JSON.stringify(res.error)}`);
  }

  return res.data;
};
