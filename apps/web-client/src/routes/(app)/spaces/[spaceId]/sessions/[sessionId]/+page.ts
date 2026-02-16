import type { PageLoad } from "./$types";

export const load: PageLoad = ({ params }) => {
  return { sessionId: params.sessionId, spaceId: params.spaceId };
};
