/**
 * Daemon wrapper for OAuth resilience QA.
 *
 * Delegates to the live-daemon harness's startDaemon/stopDaemon, layering
 * the OAuth-resilience-specific env vars on top:
 *
 *   FRIDAY_OAUTH_MOCK_EXCHANGE_URI  → makes google-providers point at the mock
 *   FRIDAY_OAUTH_MOCK_REFRESH_URI   → same, refresh route
 *   LINK_DEV_MODE=true              → skip JWT verify, default user id "dev"
 *   FRIDAY_ELICITATION_TTL_MS_OVERRIDE
 *     → shortens elicitation TTL so the "expired" scenarios don't take 2
 *       minutes. NOTE: this env var is referenced by the QA plan but has not
 *       yet been wired into the daemon (see `docs/plans/
 *       2026-05-11-oauth-refresh-resilience-qa.md` "Open questions for QA"
 *       section). We forward it anyway so scenarios are valid the moment the
 *       support lands; until then the env value is ignored by the daemon and
 *       expiration scenarios fall back to the production TTL.
 *
 * The env-merge logic itself lives in `daemon-env.ts` so vitest can exercise
 * it without dragging in jsr: imports.
 */

import {
  type DaemonHandle,
  type StartDaemonOptions,
  startDaemon as startBaseDaemon,
  stopDaemon as stopBaseDaemon,
} from "../live-daemon/harness.ts";
import { type BuildDaemonEnvOptions, buildDaemonEnv } from "./daemon-env.ts";

export type { DaemonHandle } from "../live-daemon/harness.ts";
export { buildDaemonEnv, DEFAULT_ELICITATION_TTL_MS } from "./daemon-env.ts";

export interface StartOAuthQADaemonOptions
  extends Omit<StartDaemonOptions, "env">,
    BuildDaemonEnvOptions {}

/**
 * Start a daemon configured for the OAuth resilience scenarios. The mock
 * server must already be running so its URL is known.
 */
export async function startDaemon(options: StartOAuthQADaemonOptions): Promise<DaemonHandle> {
  const { mockBaseUrl, elicitationTtlMs, extraEnv, ...base } = options;
  return await startBaseDaemon({
    ...base,
    env: buildDaemonEnv({ mockBaseUrl, elicitationTtlMs, extraEnv }),
  });
}

export async function stopDaemon(
  handle: DaemonHandle,
  opts: { keepHome?: boolean } = {},
): Promise<void> {
  await stopBaseDaemon(handle, opts);
}
