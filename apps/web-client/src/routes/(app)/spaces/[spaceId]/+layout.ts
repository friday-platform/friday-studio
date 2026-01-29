import { client, parseResult } from "@atlas/client/v2";
import { error } from "@sveltejs/kit";
import type { LayoutLoad } from "./$types";

export const load: LayoutLoad = async ({ params }) => {
  const res = await parseResult(
    client.workspace[":workspaceId"].$get({ param: { workspaceId: params.spaceId } }),
  );

  if (!res.ok) {
    error(404, `Workspace not found: ${params.spaceId}`);
  }

  return { workspace: res.data };
};
