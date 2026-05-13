import { Hono } from "hono";
import { updateChecker } from "../lib/update-checker.ts";

const RATE_LIMIT_MS = 10_000;

/**
 * Studio update-check routes.
 *
 * GET / — returns current cached state (synchronous, no fetch).
 * POST /check — forces a fresh fetch unless the last check was within
 * RATE_LIMIT_MS, in which case the cached state is returned without
 * re-fetching. The window is computed from `lastCheckedAt` so the cache
 * is the single source of truth for "when did we last hit the network".
 */
export const updatesRoute = new Hono()
  .get("/", (c) => c.json(updateChecker.getUpdateStatus()))
  .post("/check", async (c) => {
    const current = updateChecker.getUpdateStatus();
    if (
      current.lastCheckedAt !== null &&
      Date.now() - new Date(current.lastCheckedAt).getTime() < RATE_LIMIT_MS
    ) {
      return c.json(current);
    }
    const updated = await updateChecker.forceCheck();
    return c.json(updated);
  });
