import type { NarrativeEntry } from "@atlas/agent-sdk";
import { z } from "zod";

export const DiscoverySchema = z.object({
  discovered_by: z.string(),
  discovered_session: z.string(),
  target_workspace_id: z.string(),
  target_signal_id: z.string(),
  title: z.string(),
  brief: z.string(),
  target_files: z.array(z.string()),
  priority: z.number().min(0).max(100),
  kind: z.string(),
  auto_apply: z.boolean(),
});

export type Discovery = z.infer<typeof DiscoverySchema>;

const BacklogPayloadSchema = z.object({
  workspace_id: z.string(),
  signal_id: z.string(),
  task_id: z.string(),
  task_brief: z.string(),
  target_files: z.array(z.string()),
});

const BacklogMetadataSchema = z.object({
  status: z.enum(["pending", "running", "done", "rejected"]),
  priority: z.number(),
  kind: z.string(),
  blocked_by: z.array(z.string()),
  match_job_name: z.string(),
  auto_apply: z.boolean(),
  discovered_by: z.string(),
  discovered_session: z.string(),
  payload: BacklogPayloadSchema,
});

export type BacklogPayload = z.infer<typeof BacklogPayloadSchema>;
export type BacklogMetadata = z.infer<typeof BacklogMetadataSchema>;

const AppendDiscoveryResponseSchema = z.object({ id: z.string(), createdAt: z.string() });

export function slug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export async function shortHash(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 8);
}

export async function appendDiscoveryAsTask(
  storeBaseUrl: string,
  discovery: Discovery,
): Promise<{ id: string; createdAt: string }> {
  const validated = DiscoverySchema.parse(discovery);

  const hash = await shortHash(validated.title + validated.discovered_session);
  const id = `auto-${validated.kind}-${slug(validated.title)}-${hash}`;

  const metadata: BacklogMetadata = {
    status: "pending",
    priority: validated.priority,
    kind: validated.kind,
    blocked_by: [],
    match_job_name: "execute-task",
    auto_apply: validated.auto_apply,
    discovered_by: validated.discovered_by,
    discovered_session: validated.discovered_session,
    payload: {
      workspace_id: validated.target_workspace_id,
      signal_id: validated.target_signal_id,
      task_id: id,
      task_brief: validated.brief,
      target_files: validated.target_files,
    },
  };

  const entry: NarrativeEntry = {
    id,
    text: validated.title,
    createdAt: new Date().toISOString(),
    metadata,
  };

  const res = await fetch(storeBaseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(entry),
  });

  if (!res.ok) {
    throw new Error(`POST ${storeBaseUrl} failed: HTTP ${res.status}`);
  }

  const body: unknown = await res.json();
  return AppendDiscoveryResponseSchema.parse(body);
}
