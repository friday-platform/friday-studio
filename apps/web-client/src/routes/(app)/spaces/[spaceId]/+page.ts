import { client, parseResult } from "@atlas/client/v2";
import { loadWorkspaceIntegrations } from "$lib/modules/integrations/types";
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ params, parent }) => {
  const { workspace } = await parent();

  if (workspace.metadata?.requires_setup) {
    return {
      requiresSetup: true,
      integrations: await loadWorkspaceIntegrations(params.spaceId),
      artifacts: [],
      resources: [],
    };
  }

  const [artifactsRes, resourcesRes, integrations] = await Promise.all([
    parseResult(
      client.artifactsStorage.index.$get({ query: { workspaceId: params.spaceId, limit: "10" } }),
    ),
    parseResult(
      client.workspace[":workspaceId"].resources.$get({ param: { workspaceId: params.spaceId } }),
    ),
    loadWorkspaceIntegrations(params.spaceId),
  ]);

  return {
    requiresSetup: false,
    integrations,
    artifacts: artifactsRes.ok ? artifactsRes.data.artifacts : [],
    resources: resourcesRes.ok ? resourcesRes.data.resources : [],
  };
};
