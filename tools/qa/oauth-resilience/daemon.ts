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

import { join } from "jsr:@std/path@1";
import {
  type DaemonHandle,
  type StartDaemonOptions,
  startDaemon as startBaseDaemon,
  stopDaemon as stopBaseDaemon,
} from "../live-daemon/harness.ts";
import { type BuildDaemonEnvOptions, buildDaemonEnv } from "./daemon-env.ts";
import { seedCredentials } from "./seed.ts";

export type { DaemonHandle } from "../live-daemon/harness.ts";
export { buildDaemonEnv, DEFAULT_ELICITATION_TTL_MS } from "./daemon-env.ts";

export interface StartOAuthQADaemonOptions
  extends Omit<StartDaemonOptions, "env">,
    BuildDaemonEnvOptions {
  /**
   * Skip the credential seed step. Default false. Tests that don't need
   * Google credentials in storage (e.g. infra unit tests) set this true.
   */
  skipCredentialSeed?: boolean;
}

/**
 * Start a daemon configured for the OAuth resilience scenarios. The mock
 * server must already be running so its URL is known.
 *
 * Seeds the Google credential fixtures into `<FRIDAY_HOME>/credentials/dev/`
 * before the daemon spawns so the QA workspace's Google MCP servers
 * have something to refresh against. The FRIDAY_HOME is materialized
 * here (not inside the base harness) so the seed step lands in the
 * same directory the daemon boots against.
 */
export async function startDaemon(options: StartOAuthQADaemonOptions): Promise<DaemonHandle> {
  const { mockBaseUrl, elicitationTtlMs, extraEnv, skipCredentialSeed, ...base } = options;
  const fridayHome =
    base.fridayHome ?? (await Deno.makeTempDir({ prefix: "friday-qa-oauth-resilience-" }));
  if (skipCredentialSeed !== true) {
    await seedCredentials({ fridayHome });
  }
  return await startBaseDaemon({
    ...base,
    fridayHome,
    env: buildDaemonEnv({ mockBaseUrl, elicitationTtlMs, extraEnv }),
  });
}

/** Absolute path of the credentials directory for a given user. */
export function credentialsDir(fridayHome: string, userId: string = "dev"): string {
  return join(fridayHome, "credentials", userId);
}

export async function stopDaemon(
  handle: DaemonHandle,
  opts: { keepHome?: boolean } = {},
): Promise<void> {
  await stopBaseDaemon(handle, opts);
}
