import {
  type CredentialSummary,
  fetchLinkCredential,
  resolveCredentialsByProvider,
} from "@atlas/core/mcp-registry/credential-resolver";
import { createLogger } from "@atlas/logger";

const logger = createLogger({ component: "slack-credentials" });

interface SlackCredentialSecret {
  externalId: string;
  access_token: string;
  token_type: string;
}

/**
 * Look up Slack bot token.
 *
 * Returns first slack-app credential found.
 * Multi-Slack-workspace per user not supported.
 *
 * @param teamId - For logging context (not used for matching)
 * @returns access_token if found, null if no credential exists
 * @throws Error if Link API fails (not CredentialNotFoundError)
 */
export async function getSlackTokenByTeamId(teamId: string): Promise<string | null> {
  let summaries: CredentialSummary[];
  try {
    summaries = await resolveCredentialsByProvider("slack");
  } catch (error) {
    if ((error as Error).name === "CredentialNotFoundError") {
      logger.debug("slack_no_credentials", { teamId });
      return null;
    }
    throw error;
  }

  // First credential wins
  const first = summaries.at(0);
  if (!first) {
    logger.debug("slack_no_credentials", { teamId });
    return null;
  }

  const credential = await fetchLinkCredential(first.id, logger);
  const secret = credential.secret as unknown as SlackCredentialSecret;

  logger.debug("slack_credential_found", { teamId, credentialId: first.id });
  return secret.access_token;
}
