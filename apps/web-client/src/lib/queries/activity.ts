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
 * Mark activity items as viewed or dismissed.
 */
export async function markActivity(
  payload:
    | { activityIds: string[]; status: "viewed" | "dismissed" }
    | { before: string; status: "viewed" },
): Promise<void> {
  const res = await parseResult(client.activity.mark.$post({ json: payload }));

  if (!res.ok) {
    throw new Error(`Failed to mark activity: ${JSON.stringify(res.error)}`);
  }
}
