import type { PageLoad } from "./$types";

export const load: PageLoad = ({ params }) => {
  return { spaceId: params.spaceId, slug: params.slug };
};
