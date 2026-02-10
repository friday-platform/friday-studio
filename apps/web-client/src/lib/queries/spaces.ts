import { client, parseResult, type InferResponseType } from "@atlas/client/v2";

type WorkspacesListResponse = InferResponseType<typeof client.workspace.index.$get, 200>;

export async function listSpaces(): Promise<WorkspacesListResponse> {
  const res = await parseResult(client.workspace.index.$get());
  if (!res.ok) {
    console.error("Failed to load spaces:", res.error);
    throw new Error("Failed to load spaces");
  }
  return res.data.filter((w) => w.name !== "friday-conversation" && w.name !== "atlas-conversation" && !w.path.includes("/examples/"));
}
