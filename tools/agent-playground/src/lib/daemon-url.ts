import { z } from "zod";

/** Base URL of the local Atlas daemon. Used by the server-side proxy. */
export const DAEMON_BASE_URL = "http://localhost:8080";

// Validate and normalize external URL from env var
const validateExternalUrl = (envValue: unknown, defaultUrl: string): string => {
	const parsed = z.string().url().safeParse(envValue);
	if (!parsed.success) return defaultUrl;
	// Strip trailing slash to prevent double slashes in URL construction
	return parsed.data.replace(/\/$/, "");
};

/** Browser-facing daemon URL. Reads VITE_EXTERNAL_DAEMON_URL for custom port mapping.
 * Default matches the launcher's atlasd port (project.go) so OAuth redirects
 * from the bundled Studio playground hit the right place when no env override
 * is provided at build time. The `deno task playground` dev script sets the
 * env var explicitly, so this fallback only kicks in for the compiled binary.
 */
export const EXTERNAL_DAEMON_URL = validateExternalUrl(
	import.meta.env.VITE_EXTERNAL_DAEMON_URL,
	"http://localhost:8080"
);

/** Browser-facing tunnel URL. Reads VITE_EXTERNAL_TUNNEL_URL for custom port mapping.
 * Default matches the launcher's webhook-tunnel port (project.go).
 */
export const EXTERNAL_TUNNEL_URL = validateExternalUrl(
	import.meta.env.VITE_EXTERNAL_TUNNEL_URL,
	"http://localhost:9090"
);
