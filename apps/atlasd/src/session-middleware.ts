/**
 * Cookie-bearing session middleware.
 *
 * Reads the opaque session token from the `friday_session` cookie or
 * an `Authorization: Bearer <token>` header, validates it against the
 * SESSIONS KV bucket, and stamps `ctx.userId` on the Hono context.
 *
 * Dev mode (`FRIDAY_ENV === "dev"`, the default for local-first
 * Friday Studio): missing or invalid token causes a fresh session to
 * be minted against the local user's canonical id and a `Set-Cookie`
 * header to be added to the response. The request proceeds — the
 * single-user-local experience is unauthenticated from the user's
 * perspective.
 *
 * Non-dev mode (`FRIDAY_ENV` set to anything else, e.g. "production"):
 * missing or invalid token returns 401. (The login flow that creates
 * the session record is out-of-scope for this phase; once it lands,
 * downstream handlers are unchanged because the contract is
 * "ctx.userId is set or the middleware already 401'd".)
 *
 * The cookie attributes are `HttpOnly; SameSite=Lax; Path=/;
 * Max-Age=<ttl>`. `Secure` is added when the request arrived over
 * HTTPS (via Host header / forwarded-proto). The token is opaque —
 * no claims, no signature — so revocation is `SessionStorage.delete`.
 */

import process from "node:process";
import { SessionStorage } from "@atlas/core/sessions/storage";
import { UserStorage } from "@atlas/core/users/storage";
import { logger } from "@atlas/logger";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";

const COOKIE_NAME = "friday_session";
/** 90 days in seconds, matching DEFAULT_SESSION_TTL_MS. */
const COOKIE_MAX_AGE_SECONDS = 90 * 24 * 60 * 60;

function isHttps(c: Context): boolean {
  const forwardedProto = c.req.header("x-forwarded-proto");
  if (forwardedProto) return forwardedProto.split(",")[0]?.trim() === "https";
  try {
    return new URL(c.req.url).protocol === "https:";
  } catch {
    return false;
  }
}

function extractToken(c: Context): string | undefined {
  const cookie = getCookie(c, COOKIE_NAME);
  if (cookie) return cookie;
  const auth = c.req.header("authorization");
  if (!auth) return undefined;
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

function attachCookie(c: Context, token: string): void {
  setCookie(c, COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE_SECONDS,
    secure: isHttps(c),
  });
}

/**
 * Build the session middleware. Pass `{ devEnv: () => boolean }` so
 * tests can flip behavior without mutating `process.env`.
 *
 * Defaults to dev when `FRIDAY_ENV` is unset. Friday Studio is
 * local-first; opting into multi-tenant behavior requires an
 * explicit non-`dev` value (e.g. `FRIDAY_ENV=production`).
 */
export function createSessionMiddleware(
  options: { devEnv?: () => boolean } = {},
): MiddlewareHandler {
  const isDevEnv =
    options.devEnv ??
    (() => {
      const v = process.env.FRIDAY_ENV;
      return !v || v.toLowerCase().trim() === "dev";
    });

  return async (c, next) => {
    const token = extractToken(c);

    if (token) {
      const result = await SessionStorage.getSession(token);
      if (result.ok && result.data) {
        c.set("userId", result.data.userId);
        await next();
        return;
      }
    }

    if (isDevEnv()) {
      // Auto-mint: bind to the daemon's local user id (already warmed
      // at startup so this is a synchronous read).
      let localUserId: string;
      try {
        localUserId = UserStorage.getCachedLocalUserId();
      } catch (err) {
        logger.error("Session middleware: local user id not warmed", { error: String(err) });
        return c.json({ error: "User identity unavailable" }, 503);
      }
      const created = await SessionStorage.createSession(localUserId);
      if (!created.ok) {
        logger.error("Failed to create local session", { error: created.error });
        return c.json({ error: "Failed to create session" }, 503);
      }
      attachCookie(c, created.data.token);
      c.set("userId", localUserId);
      await next();
      return;
    }

    return c.json({ error: "Unauthorized" }, 401);
  };
}
