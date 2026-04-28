import { Buffer } from "node:buffer";
import process from "node:process";
import { logger } from "@atlas/logger";

/**
 * Build a self-signed JWT for single-user local mode.
 *
 * Mirrors `docker/run-platform.sh`: HS256 header + payload with issuer,
 * email, sub, and `user_metadata.tempest_user_id`. The signature segment is
 * the literal string "local" — `getCurrentUser()` only decodes the payload
 * (it never verifies the signature in local mode), so this is sufficient
 * for identity without requiring real auth.
 */
function buildLocalKey(): string {
  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    iss: "friday-platform",
    email: "platform-local@hellofriday.ai",
    sub: "local-user",
    user_metadata: { tempest_user_id: "local-user" },
  };
  const b64url = (obj: object) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${b64url(header)}.${b64url(payload)}.local`;
}

/**
 * Generate an in-process FRIDAY_KEY when one isn't configured.
 *
 * Friday Studio is single-user-local-first: requiring users to obtain a real
 * token before basic flows (skill publish, workspace creation) work breaks
 * the out-of-the-box experience. Mirror the Docker entrypoint's behavior so
 * the desktop binary works offline with no setup. The key lives only for
 * this daemon process — restart regenerates a fresh one.
 */
export function ensureLocalFridayKey(): string {
  const key = buildLocalKey();
  process.env.FRIDAY_KEY = key;
  process.env.FRIDAY_LOCAL_ONLY = "true";
  logger.info("Auto-generated ephemeral FRIDAY_KEY for single-user identity");
  return key;
}
