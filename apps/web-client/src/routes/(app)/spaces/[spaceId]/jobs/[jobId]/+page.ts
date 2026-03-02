import { client, parseResult } from "@atlas/client/v2";
import { error } from "@sveltejs/kit";
import { loadWorkspaceIntegrations } from "$lib/modules/integrations/types";
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ params }) => {
  const [result, integrations] = await Promise.all([
    parseResult(
      client.jobs[":jobId"][":workspaceId"].$get({
        param: { jobId: params.jobId, workspaceId: params.spaceId },
      }),
    ),
    loadWorkspaceIntegrations(params.spaceId),
  ]);

  if (!result.ok) {
    error(500, `Failed to load job details: ${JSON.stringify(result.error)}`);
  }

  return { jobId: params.jobId, spaceId: params.spaceId, job: result.data, integrations };
};
