import { client, parseResult, type InferResponseType } from "@atlas/client/v2";

type JobsResponse = InferResponseType<
  (typeof client.workspace)[":workspaceId"]["jobs"]["$get"],
  200
>;

export type JobInfo = JobsResponse[number];

/**
 * Fetch jobs for a specific workspace.
 */
export async function listWorkspaceJobs(workspaceId: string): Promise<JobInfo[]> {
  const res = await parseResult(
    client.workspace[":workspaceId"].jobs.$get({ param: { workspaceId } }),
  );

  if (!res.ok) {
    throw new Error(`Failed to load jobs: ${JSON.stringify(res.error)}`);
  }

  return res.data;
}
