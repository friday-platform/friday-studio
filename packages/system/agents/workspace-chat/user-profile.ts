import { USER_PROFILE_CORPUS } from "@atlas/agent-sdk";
import type { Logger } from "@atlas/logger";
import { getAtlasDaemonUrl } from "@atlas/oapi-client";
import { z } from "zod";

export type UserProfileState =
  | { status: "known"; name: string }
  | { status: "declined" }
  | { status: "unknown" };

const NAME_EXTRACT = /(?:name is|call me)\s+(.+)/i;

const NarrativeEntrySchema = z.object({
  id: z.string(),
  text: z.string(),
  author: z.string().optional(),
  createdAt: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export function parseUserProfileState(
  entries: Array<{ text: string; metadata?: Record<string, unknown> }>,
): UserProfileState {
  for (const entry of entries) {
    if (entry.metadata?.type === "user-name") {
      const match = NAME_EXTRACT.exec(entry.text);
      const name = match?.[1] ?? entry.text;
      return { status: "known", name: name.trim() };
    }
  }

  for (const entry of entries) {
    if (entry.metadata?.type === "name-declined") {
      return { status: "declined" };
    }
  }

  return { status: "unknown" };
}

export async function fetchUserProfileState(
  workspaceId: string,
  logger: Logger,
): Promise<UserProfileState> {
  const daemonUrl = getAtlasDaemonUrl();
  const url = `${daemonUrl}/api/memory/${encodeURIComponent(workspaceId)}/narrative/${USER_PROFILE_CORPUS}?limit=50`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      logger.warn("user-notes fetch failed", { workspaceId, status: res.status });
      return { status: "unknown" };
    }
    const parsed = z.array(NarrativeEntrySchema).safeParse(await res.json());
    if (!parsed.success) {
      logger.warn("user-notes response invalid", { workspaceId });
      return { status: "unknown" };
    }
    return parseUserProfileState(parsed.data);
  } catch (err) {
    logger.warn("user-notes fetch error", { workspaceId, error: err });
    return { status: "unknown" };
  }
}
