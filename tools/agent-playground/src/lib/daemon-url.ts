import { z } from "zod";

/** Base URL of the local Atlas daemon, used by server-side proxies inside
 * this package (the static-server's /api/daemon proxy and the Hono
 * router). NOT exposed to the browser — the browser hits the playground
 * itself, which proxies to the daemon. Resolved from FRIDAYD_URL at
 * runtime when present so the same binary works against any local port
 * layout the launcher chooses; falls back to localhost:8080 because
 * `deno task atlas daemon start` binds there by default. */
const _serverEnv =
	typeof process !== "undefined" && typeof process.env === "object" ? process.env : undefined;
export const DAEMON_BASE_URL = _serverEnv?.FRIDAYD_URL ?? "http://localhost:8080";

interface RuntimeConfig {
	externalDaemonUrl?: string;
	externalTunnelUrl?: string;
}

declare global {
	interface Window {
		__FRIDAY_CONFIG__?: RuntimeConfig;
	}
}

const urlSchema = z.string().url();

function normalize(value: string): string {
	const parsed = urlSchema.safeParse(value);
	if (!parsed.success) {
		throw new Error(`invalid URL configured: ${value}`);
	}
	return parsed.data.replace(/\/$/, "");
}

/** Resolves a browser-facing URL from, in order:
 *   1. `window.__FRIDAY_CONFIG__[key]` — injected by static-server at
 *      request time from the playground binary's process env. This is
 *      the production path: the Studio launcher passes EXTERNAL_*_URL
 *      values through to the playground process, which embeds them in
 *      the served HTML. Nothing about the URLs is baked into the JS bundle.
 *   2. `import.meta.env.VITE_*` — Vite-replaced at dev-build time, used
 *      only by `deno task playground` (the dev script in deno.json sets
 *      these via env on the vite-dev command line).
 * If neither resolves, throw — better to fail loudly than silently point
 * at the wrong port. Resolution is lazy (called per access) so the throw
 * fires in the browser, not during SvelteKit's build-time module
 * analysis where neither source is populated.
 */
function resolve(
	configKey: keyof RuntimeConfig,
	viteValue: string | undefined,
	humanName: string,
): string {
	const fromWindow = typeof window !== "undefined" ? window.__FRIDAY_CONFIG__?.[configKey] : undefined;
	const candidate = fromWindow ?? viteValue;
	if (!candidate) {
		throw new Error(
			`${humanName} is not configured. ` +
				`Production: static-server must inject window.__FRIDAY_CONFIG__.${configKey} ` +
				`(set ${configKey === "externalDaemonUrl" ? "EXTERNAL_DAEMON_URL or FRIDAYD_URL" : "EXTERNAL_TUNNEL_URL"} on the playground process). ` +
				`Dev: set VITE_${configKey === "externalDaemonUrl" ? "EXTERNAL_DAEMON_URL" : "EXTERNAL_TUNNEL_URL"} in the vite env.`,
		);
	}
	return normalize(candidate);
}

/** Browser-facing daemon URL. Lazy: evaluated per call so SvelteKit's
 * build-time prerender doesn't trip the missing-config throw. */
export function externalDaemonUrl(): string {
	return resolve("externalDaemonUrl", import.meta.env.VITE_EXTERNAL_DAEMON_URL, "External daemon URL");
}

/** Browser-facing webhook-tunnel URL. */
export function externalTunnelUrl(): string {
	return resolve("externalTunnelUrl", import.meta.env.VITE_EXTERNAL_TUNNEL_URL, "External tunnel URL");
}
