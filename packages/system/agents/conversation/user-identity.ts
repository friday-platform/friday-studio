/**
 * Fetch user identity from /api/me and format for system prompt.
 * Returns undefined if unavailable (graceful degradation).
 */

import { client, parseResult } from "@atlas/client/v2";
import type { Logger } from "@atlas/logger";

export async function fetchUserIdentitySection(logger: Logger): Promise<string | undefined> {
  try {
    const result = await parseResult(client.me.index.$get());
    if (!result.ok || !result.data.user) {
      logger.warn("User identity unavailable", { error: result.ok ? "no user" : result.error });
      return undefined;
    }

    const { full_name, email, display_name } = result.data.user;
    return `<user_identity>
Name: ${display_name ?? full_name}
Email: ${email}
</user_identity>`;
  } catch (error) {
    logger.error("Failed to fetch user identity", { error });
    return undefined;
  }
}
