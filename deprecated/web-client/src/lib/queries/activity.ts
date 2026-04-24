import { client, parseResult, type InferResponseType } from "@atlas/client/v2";

type ListResponse = InferResponseType<typeof client.activity.index.$get, 200>;

export type ActivityWithReadStatus = ListResponse["activities"][number];

/**
 * Fetch a page of activity items.
 */
export async function listActivity(
  offset?: number,
): Promise<{ activities: ActivityWithReadStatus[]; hasMore: boolean }> {
  const res = await parseResult(
    client.activity.index.$get({
      query: { limit: "50", offset: offset !== undefined ? String(offset) : undefined },
    }),
  );

  if (!res.ok) {
    throw new Error(`Failed to load activity: ${JSON.stringify(res.error)}`);
  }

  return res.data;
}

/**
 * Fetch a page of activity items filtered by workspace.
 */
export async function listWorkspaceActivity(
  workspaceId: string,
  options?: { limit?: number; offset?: number },
): Promise<{ activities: ActivityWithReadStatus[]; hasMore: boolean }> {
  const query: Record<string, string> = { workspaceId };
  if (options?.limit) query.limit = String(options.limit);
  if (options?.offset) query.offset = String(options.offset);
  const res = await parseResult(client.activity.index.$get({ query }));

  if (!res.ok) {
    throw new Error(`Failed to load activity: ${JSON.stringify(res.error)}`);
  }

  return res.data;
}

/**
 * Fetch the unread activity count, optionally scoped to a workspace.
 */
export async function getWorkspaceUnreadCount(workspaceId: string): Promise<number> {
  const res = await parseResult(client.activity["unread-count"].$get({ query: { workspaceId } }));

  if (!res.ok) {
    throw new Error(`Failed to load unread count: ${JSON.stringify(res.error)}`);
  }

  return res.data.count;
}

/**
 * Mark activity items as viewed or dismissed.
 */
export async function markActivity(
  payload:
    | { activityIds: string[]; status: "viewed" | "dismissed" }
    | { before: string; status: "viewed"; workspaceId?: string },
): Promise<void> {
  const res = await parseResult(client.activity.mark.$post({ json: payload }));

  if (!res.ok) {
    throw new Error(`Failed to mark activity: ${JSON.stringify(res.error)}`);
  }
}
