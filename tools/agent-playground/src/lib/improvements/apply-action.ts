import { z } from "zod";

const PROXY_BASE = "/api/daemon";

export const FindingActionSchema = z.object({
  findingId: z.string(),
  workspaceId: z.string(),
  disposition: z.enum(["accept", "reject", "dismiss"]),
  patch: z.string().optional(),
});

export const ApplyResponseSchema = z.object({
  ok: z.boolean(),
  appliedVersion: z.string().optional(),
  error: z.string().optional(),
});

export type FindingAction = z.infer<typeof FindingActionSchema>;
export type ApplyResponse = z.infer<typeof ApplyResponseSchema>;

async function postAction(action: FindingAction): Promise<ApplyResponse> {
  const res = await globalThis.fetch(
    `${PROXY_BASE}/api/improvements/apply`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(action),
    },
  );

  const data: unknown = await res.json();
  return ApplyResponseSchema.parse(data);
}

export function acceptFinding(
  findingId: string,
  workspaceId: string,
  patch: string,
): Promise<ApplyResponse> {
  return postAction({
    findingId,
    workspaceId,
    disposition: "accept",
    patch,
  });
}

export function rejectFinding(
  findingId: string,
  workspaceId: string,
): Promise<ApplyResponse> {
  return postAction({
    findingId,
    workspaceId,
    disposition: "reject",
  });
}

export function dismissFinding(
  findingId: string,
  workspaceId: string,
): Promise<ApplyResponse> {
  return postAction({
    findingId,
    workspaceId,
    disposition: "dismiss",
  });
}
