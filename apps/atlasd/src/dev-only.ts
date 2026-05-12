/**
 * Helpers for routes that should only respond outside `FRIDAY_ENV=dev`
 * when an instance-admin authorizes them.
 *
 * Several HTTP surfaces on the daemon are operator-level: env-file
 * read/write (`/api/config/env`), the Link credential proxy
 * (`/api/link/*`), full-instance exports that pull in global skill
 * state, and the in-memory `conversationStorage` debug routes. In
 * single-user Studio they're useful affordances; in any multi-user
 * deployment they're a tenant-isolation hole.
 *
 * The session middleware already gates these on having a valid
 * session, but membership-in-a-workspace isn't the right model for
 * daemon-wide surfaces. Until an instance-admin role lands, gate
 * these on `FRIDAY_ENV=dev` and 403 in any other environment. Cloud
 * deployments don't lose anything — the Studio installer + CLI
 * `daemon start` both set `FRIDAY_ENV=dev` for the local-first UX.
 */

import process from "node:process";
import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";

function isDev(): boolean {
  return process.env.FRIDAY_ENV?.toLowerCase().trim() === "dev";
}

/**
 * Throws HTTPException(403) if `FRIDAY_ENV` is anything other than
 * `dev`. Call from inside a handler that needs operator-level access.
 */
export function requireDevEnv(_c: Context): void {
  if (!isDev()) {
    throw new HTTPException(403, {
      message: "Forbidden — this endpoint is only available in dev mode.",
    });
  }
}

/**
 * Hono middleware form. Mount at the top of an admin-only router so
 * every nested route 403s in non-dev without each handler having to
 * re-check.
 */
export function devOnlyMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    requireDevEnv(c);
    await next();
  };
}
