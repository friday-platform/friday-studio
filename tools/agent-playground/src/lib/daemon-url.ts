/** Browser-facing daemon URL — same-origin proxy path served by
 * `/api/daemon/[...path]/+server.ts` (dev) or `static-server.ts` (prod).
 * Using same-origin means the browser only ever needs to trust the
 * playground origin's cert; the daemon ships a private-CA cert that no
 * system trust store knows about, and the proxy injects the right
 * NODE_EXTRA_CA_CERTS-aware fetch behind the scenes.
 *
 * Browser-only — every caller is a click handler / mount effect / popup
 * URL builder. Server-side code should call `effectiveDaemonUrl()` from
 * `$lib/server/daemon-url` instead. */
export function daemonUrl(): string {
	return `${globalThis.location.origin}/api/daemon`;
}

/** Browser-facing webhook-tunnel URL — same-origin proxy path served by
 * `/api/tunnel/[...path]/+server.ts` (dev) or `static-server.ts` (prod).
 * Server-side code should call `effectiveTunnelUrl()` from
 * `$lib/server/daemon-url` instead. */
export function tunnelUrl(): string {
	return `${globalThis.location.origin}/api/tunnel`;
}
