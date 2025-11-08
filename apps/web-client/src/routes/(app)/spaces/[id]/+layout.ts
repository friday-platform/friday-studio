import { client, parseResult } from "@atlas/client/v2";
import { error } from "@sveltejs/kit";
import type { LayoutData } from "./$types";

export const load: LayoutData = async ({ params }) => {
  const res = await parseResult(
    client.workspace[":workspaceId"].$get({ param: { workspaceId: params.id } }),
  );

  if (!res.ok) {
    error(404, `Workspace not found: ${params.id}`);
  }

  return { workspace: res.data };
};
