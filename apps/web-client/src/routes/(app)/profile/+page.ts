import { client, parseResult } from "@atlas/client/v2";
import { error } from "@sveltejs/kit";
import type { PageLoad } from "./$types";

export const load: PageLoad = async () => {
  const res = await parseResult(client.me.index.$get());

  if (!res.ok) {
    error(500, `Failed to load user profile: ${JSON.stringify(res.error)}`);
  }

  return { user: res.data.user };
};
