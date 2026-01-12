import { client, parseResult } from "@atlas/client/v2";
import type { LayoutLoad } from "./$types";

export const load: LayoutLoad = async () => {
  const res = await parseResult(client.me.index.$get());
  return { user: res.ok && res.data.success ? res.data.user : null };
};
