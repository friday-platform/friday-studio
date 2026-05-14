/** Base URL of the local Atlas daemon, used by the SvelteKit SSR proxy
 * (`/api/daemon/*` route). The scheme is injected at build time by vite
 * via the `__FRIDAY_DAEMON_BASE_URL__` define key (see vite.config.ts).
 * We can't read it from `process.env` because vite's
 * `define: { "process.env": "{}" }` wipes that for everything that goes
 * through the route SSR transform — an http→https daemon mismatch trips
 * an HTTPParserError as soon as the daemon starts the TLS handshake on a
 * cleartext request.
 *
 * The compiled binary uses `static-server.ts` which reads `FRIDAYD_URL`
 * from env directly. */
declare const __FRIDAY_DAEMON_BASE_URL__: string | undefined;
declare const __FRIDAY_TUNNEL_BASE_URL__: string | undefined;
export const DAEMON_BASE_URL =
	typeof __FRIDAY_DAEMON_BASE_URL__ !== "undefined"
		? __FRIDAY_DAEMON_BASE_URL__
		: "http://localhost:8080";
export const TUNNEL_BASE_URL =
	typeof __FRIDAY_TUNNEL_BASE_URL__ !== "undefined"
		? __FRIDAY_TUNNEL_BASE_URL__
		: "http://localhost:9090";

/** Browser-facing daemon URL — same-origin proxy path served by
 * `/api/daemon/[...path]/+server.ts` (dev) or `static-server.ts` (prod).
 * Using same-origin means the browser only ever needs to trust the
 * playground origin's cert; the daemon ships a private-CA cert that no
 * system trust store knows about, and the proxy injects the right
 * NODE_EXTRA_CA_CERTS-aware fetch behind the scenes.
 *
 * Browser-only — every caller is a click handler / mount effect / popup
 * URL builder. */
export function daemonUrl(): string {
	return `${globalThis.location.origin}/api/daemon`;
}

/** Browser-facing webhook-tunnel URL — same-origin proxy path served by
 * `/api/tunnel/[...path]/+server.ts` (dev) or `static-server.ts` (prod). */
export function tunnelUrl(): string {
	return `${globalThis.location.origin}/api/tunnel`;
}
