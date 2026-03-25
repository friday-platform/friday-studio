import process from "node:process";
import { fetchLinkCredential } from "@atlas/core/mcp-registry/credential-resolver";
import { createLogger } from "@atlas/logger";
import { z } from "zod";

const SlackCredentialSecretSchema = z.object({ access_token: z.string() });

const ByWorkspaceResponseSchema = z.object({ credential_id: z.string(), app_id: z.string() });

const logger = createLogger({ component: "slack-credentials" });

/** Resolve the bot token for the Slack app wired to a workspace. */
export async function getSlackBotToken(workspaceId: string): Promise<string | null> {
  const linkServiceUrl = process.env.LINK_SERVICE_URL ?? "http://localhost:3100";
  const url = `${linkServiceUrl}/internal/v1/slack-apps/by-workspace/${encodeURIComponent(workspaceId)}`;

  const headers: Record<string, string> = {};
  if (process.env.LINK_DEV_MODE !== "true") {
    const atlasKey = process.env.ATLAS_KEY;
    if (atlasKey) {
      headers.Authorization = `Bearer ${atlasKey}`;
    }
  }

  const res = await fetch(url, { headers });

  if (res.status === 404) {
    logger.debug("slack_no_credential_for_workspace", { workspaceId });
    return null;
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Failed to resolve slack-app for workspace '${workspaceId}': ${res.status} ${body}`,
    );
  }

  const { credential_id } = ByWorkspaceResponseSchema.parse(await res.json());

  const credential = await fetchLinkCredential(credential_id, logger);
  const secret = SlackCredentialSecretSchema.parse(credential.secret);

  if (secret.access_token === "pending") {
    logger.debug("slack_credential_pending", { workspaceId, credentialId: credential_id });
    return null;
  }

  logger.debug("slack_credential_found", { workspaceId, credentialId: credential_id });
  return secret.access_token;
}
