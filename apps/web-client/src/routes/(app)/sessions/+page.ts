import { client, parseResult } from "@atlas/client/v2";
import { error } from "@sveltejs/kit";
import type { PageLoad } from "./$types";

/** System workspaces whose sessions should not appear in the global list. */
const HIDDEN_WORKSPACES = new Set(["atlas-conversation", "friday-conversation"]);

export const load: PageLoad = async () => {
  const res = await parseResult(client.sessions.index.$get());

  if (!res.ok) {
    error(500, `Failed to load sessions: ${JSON.stringify(res.error)}`);
  }

  return { sessions: res.data.sessions.filter((s) => !HIDDEN_WORKSPACES.has(s.workspaceId)) };
};
