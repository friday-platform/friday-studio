import { client, parseResult } from "@atlas/client/v2";
import { error } from "@sveltejs/kit";
import { loadWorkspaceIntegrations } from "$lib/modules/integrations/types";
import type { Integration } from "$lib/modules/integrations/types";
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ params, parent }) => {
  const { workspace } = await parent();

  if (workspace.metadata?.requires_setup) {
    return {
      requiresSetup: true,
      integrations: await loadWorkspaceIntegrations(params.spaceId),
      sessions: [],
      artifacts: [],
      resources: [],
    };
  }

  const [sessionsRes, artifactsRes, resourcesRes] = await Promise.all([
    parseResult(client.sessions.index.$get({ query: { workspaceId: params.spaceId } })),
    parseResult(
      client.artifactsStorage.index.$get({ query: { workspaceId: params.spaceId, limit: "10" } }),
    ),
    parseResult(
      client.workspace[":workspaceId"].resources.$get({ param: { workspaceId: params.spaceId } }),
    ),
  ]);

  if (!sessionsRes.ok) {
    error(500, `Failed to load workspace sessions: ${JSON.stringify(sessionsRes.error)}`);
  }

  return {
    requiresSetup: false,
    integrations: [] as Integration[],
    sessions: sessionsRes.data.sessions,
    artifacts: artifactsRes.ok ? artifactsRes.data.artifacts : [],
    resources: resourcesRes.ok ? resourcesRes.data.resources : [],
  };
};
