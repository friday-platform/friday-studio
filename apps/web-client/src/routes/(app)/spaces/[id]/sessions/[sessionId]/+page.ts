import { client, parseResult } from "@atlas/client/v2";
import { error } from "@sveltejs/kit";
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ params }) => {
  const res = await parseResult(
    client.sessionHistory[":id"].$get({ param: { id: params.sessionId } }),
  );

  if (!res.ok) {
    error(500, `Failed to load session: ${JSON.stringify(res.error)}`);
  }

  return { session: res.data };
};
