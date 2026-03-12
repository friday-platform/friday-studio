import { client, parseResult } from "@atlas/client/v2";
import { stringifyError } from "@atlas/utils";
import { error } from "@sveltejs/kit";
import type { PageLoad } from "./$types";

export interface AccountInfo {
  label?: string;
  connected: boolean;
}

export const load: PageLoad = async ({ params }) => {
  const [jobResult, configCredResult, linkSummaryResult] = await Promise.all([
    parseResult(
      client.jobs[":jobId"][":workspaceId"].$get({
        param: { jobId: params.jobId, workspaceId: params.spaceId },
      }),
    ),
    parseResult(client.workspaceConfig(params.spaceId).credentials.$get()),
    parseResult(client.link.v1.summary.$get({ query: {} })),
  ]);

  if (!jobResult.ok) {
    error(500, `Failed to load job details: ${stringifyError(jobResult.error)}`);
  }

  // Build provider → credentialId from workspace config
  const providerToCredId = new Map<string, string>();
  if (configCredResult.ok) {
    for (const cred of configCredResult.data.credentials) {
      if (cred.provider && cred.credentialId) {
        providerToCredId.set(cred.provider, cred.credentialId);
      }
    }
  }

  // Build credentialId → label from Link summary
  const credIdToLabel = new Map<string, string>();
  if (linkSummaryResult.ok) {
    for (const cred of linkSummaryResult.data.credentials) {
      credIdToLabel.set(cred.id, cred.displayName ?? cred.label);
    }
  }

  // Build provider → AccountInfo
  const accounts = new Map<string, AccountInfo>();
  for (const provider of jobResult.data.integrations) {
    const credId = providerToCredId.get(provider);
    const label = credId ? credIdToLabel.get(credId) : undefined;
    accounts.set(provider, { label, connected: Boolean(credId) });
  }

  return { jobId: params.jobId, spaceId: params.spaceId, job: jobResult.data, accounts };
};
