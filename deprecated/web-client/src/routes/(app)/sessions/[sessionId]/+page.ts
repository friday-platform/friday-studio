import { client, parseResult } from "@atlas/client/v2";
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ params }) => {
  const res = await parseResult(client.sessions[":id"].$get({ param: { id: params.sessionId } }));
  const initialStatus = res.ok ? res.data.status : undefined;
  return { sessionId: params.sessionId, initialStatus };
};
