import process from "node:process";

/** Base URL of the local Atlas daemon. Used by server-side proxies inside
 * this package (the SvelteKit `/api/daemon/*` route in dev, plus other
 * server-internal calls). NOT exposed to the browser — the browser hits
 * the playground itself, which proxies to the daemon. Resolved from
 * `FRIDAYD_URL` so the same binary works against any local port layout
 * the launcher chooses; falls back to `localhost:8080` because
 * `deno task atlas daemon start` binds there by default.
 *
 * Lives in `lib/server/` (not `lib/`) so this file is never pulled into
 * the browser bundle — `process` is a Node/Deno global that doesn't
 * exist in the browser, and biome flags `process` references in
 * non-server code.
 */
export const DAEMON_BASE_URL = process.env.FRIDAYD_URL ?? "http://localhost:8080";
