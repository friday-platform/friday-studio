import { loadWorkspaceIntegrations } from "$lib/modules/integrations/types";
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ params }) => {
  return { integrations: await loadWorkspaceIntegrations(params.spaceId) };
};
