/**
 * Env-var composition for the OAuth resilience QA daemon. Split out from
 * `daemon.ts` so unit tests can exercise the merge logic without pulling
 * in the live-daemon harness's Deno-only (jsr:) imports.
 */

export interface BuildDaemonEnvOptions {
  /** Mock server base URL (without trailing path). */
  mockBaseUrl: string;
  /**
   * Override the elicitation TTL (ms). Default 10s. Set to `null` to NOT
   * inject the override env var at all.
   */
  elicitationTtlMs?: number | null;
  /** Additional env vars merged AFTER the OAuth-resilience defaults. */
  extraEnv?: Record<string, string>;
}

export const DEFAULT_ELICITATION_TTL_MS = 10_000;

export function buildDaemonEnv(options: BuildDaemonEnvOptions): Record<string, string> {
  const env: Record<string, string> = {
    LINK_DEV_MODE: "true",
    FRIDAY_OAUTH_MOCK_EXCHANGE_URI: options.mockBaseUrl,
    FRIDAY_OAUTH_MOCK_REFRESH_URI: `${options.mockBaseUrl}/refreshToken`,
  };
  if (options.elicitationTtlMs !== null) {
    const ttl = options.elicitationTtlMs ?? DEFAULT_ELICITATION_TTL_MS;
    env.FRIDAY_ELICITATION_TTL_MS_OVERRIDE = String(ttl);
  }
  return { ...env, ...(options.extraEnv ?? {}) };
}
