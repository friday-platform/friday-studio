/**
 * Cookie-bearing session middleware.
 *
 * Reads the opaque session token from the `friday_session` cookie or
 * an `Authorization: Bearer <token>` header, validates it against the
 * SESSIONS KV bucket, and stamps `ctx.userId` on the Hono context.
 *
 * Dev mode (`FRIDAY_ENV === "dev"`): missing or invalid token causes a
 * fresh session to be minted against the local user's canonical id and
 * a `Set-Cookie` header to be added to the response. The request
 * proceeds — the single-user-local experience is unauthenticated from
 * the user's perspective.
 *
 * Any other value, INCLUDING UNSET: missing or invalid token returns
 * 401. Fail-closed by default — a misconfigured deployment that forgot
 * to set `FRIDAY_ENV` does not silently fall open to auto-minted
 * sessions. Friday Studio writes `FRIDAY_ENV=dev` into the env file at
 * install time; the CLI's `daemon start` does the same for its child
 * process when it infers dev mode.
 *
 * The cookie attributes are `HttpOnly; SameSite=Lax; Path=/;
 * Max-Age=<ttl>`. `Secure` is forced on outside dev; in dev it tracks
 * the request's effective scheme so local `http://` works. The token is
 * opaque — no claims, no signature — so revocation is
 * `SessionStorage.delete`.
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

function attachCookie(c: Context, token: string, isDev: boolean): void {
  // Outside dev, force `Secure` regardless of what the proxy reports.
  // `x-forwarded-proto` is a hint, not authoritative; a misconfigured
  // proxy that strips the header would otherwise cause us to ship a
  // session cookie without the `Secure` flag in a TLS-terminating
  // deployment. Local http:// still works because dev is the only mode
  // that relaxes the flag.
  setCookie(c, COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE_SECONDS,
    secure: isDev ? isHttps(c) : true,
  });
}

/**
 * Build the session middleware. Pass `{ devEnv: () => boolean }` so
 * tests can flip behavior without mutating `process.env`.
 *
 * Fail-closed default: only an explicit `FRIDAY_ENV=dev` enables the
 * auto-mint local-mode path. Any other value — including unset —
 * requires a valid session token and 401s otherwise. Friday Studio's
 * installer writes `FRIDAY_ENV=dev` into the env file, and the CLI's
 * `daemon start` mirrors that into its child process env, so the
 * supported local-first paths still get the convenient UX.
 */
export function createSessionMiddleware(
  options: { devEnv?: () => boolean } = {},
): MiddlewareHandler {
  const isDevEnv = options.devEnv ?? (() => process.env.FRIDAY_ENV?.toLowerCase().trim() === "dev");

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
      attachCookie(c, created.data.token, true);
      c.set("userId", localUserId);
      await next();
      return;
    }

    return c.json({ error: "Unauthorized" }, 401);
  };
}
