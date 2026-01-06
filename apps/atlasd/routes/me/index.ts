import { daemonFactory } from "../../src/factory.ts";
import { getCurrentUser } from "./adapter.ts";

/**
 * /api/me - returns authenticated user's identity.
 *
 * Uses adapter pattern for local/remote switching:
 * - Local (default when no PERSONA_URL): Extracts user from ATLAS_KEY JWT
 * - Remote (when PERSONA_URL is set): Fetches from persona service
 *
 * Set USER_IDENTITY_ADAPTER=local to force local mode.
 */
const meRoutes = daemonFactory.createApp().get("/", async (c) => {
  const result = await getCurrentUser();

  if (!result.ok) {
    return c.json({ success: false as const, error: result.error }, 503);
  }

  if (!result.data) {
    return c.json({ success: false as const, error: "User identity unavailable" }, 503);
  }

  return c.json({ success: true as const, user: result.data });
});

export { meRoutes };
export type MeRoutes = typeof meRoutes;
export type { UserIdentity } from "./schemas.ts";
