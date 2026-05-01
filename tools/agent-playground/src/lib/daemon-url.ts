import { z } from "zod";

/** Base URL of the local Atlas daemon. Used by the SvelteKit dev proxy
 * (`/api/daemon/*` route). The compiled binary uses static-server.ts
 * which reads `FRIDAYD_URL` from env for the same purpose; this dev
 * path always targets the default 8080 since it only runs under
 * `deno task playground`. */
export const DAEMON_BASE_URL = "http://localhost:8080";

interface RuntimeConfig {
	externalDaemonUrl?: string;
	externalTunnelUrl?: string;
}

declare global {
	// biome-ignore lint/style/noVar: ambient declarations require var
	var __FRIDAY_CONFIG__: RuntimeConfig | undefined;
}

const urlSchema = z.string().url();

function normalize(value: string): string {
	const parsed = urlSchema.safeParse(value);
	if (!parsed.success) {
		throw new Error(`invalid URL configured: ${value}`);
	}
	return parsed.data.replace(/\/$/, "");
}

/** Resolve a browser-facing URL from `window.__FRIDAY_CONFIG__`,
 * injected at request time. Production: `static-server.ts` reads
 * EXTERNAL_*_URL from process env and embeds them in served HTML. Dev:
 * the `fridayRuntimeConfig` Vite plugin (vite.config.ts) does the same.
 * Nothing about the URLs is baked into the JS bundle.
 *
 * Resolution is lazy (called per access) so the missing-config throw
 * fires in the browser, not during SvelteKit's build-time prerender.
 */
function resolve(configKey: keyof RuntimeConfig, envVarName: string, humanName: string): string {
	const value = globalThis.__FRIDAY_CONFIG__?.[configKey];
	if (!value) {
		throw new Error(
			`${humanName} is not configured. Set ${envVarName} on the playground process ` +
				`(launcher .env in production; deno.json playground task in dev).`,
		);
	}
	return normalize(value);
}

/** Browser-facing daemon URL. */
export function externalDaemonUrl(): string {
	return resolve("externalDaemonUrl", "EXTERNAL_DAEMON_URL", "External daemon URL");
}

/** Browser-facing webhook-tunnel URL. */
export function externalTunnelUrl(): string {
	return resolve("externalTunnelUrl", "EXTERNAL_TUNNEL_URL", "External tunnel URL");
}
