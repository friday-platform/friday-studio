import { env } from "node:process";
import * as Sentry from "@sentry/deno";
import { BUILD_COMMIT } from "./build-info.ts";

// DSN configurable via env var, defaults to main atlas project
const SENTRY_DSN =
  env.SENTRY_DSN ||
  "https://504477a5bd4822c276fac7593c5c12a1@o4507579070611456.ingest.us.sentry.io/4510468135583744";

let initialized = false;

export function isInitialized(): boolean {
  return initialized;
}

/**
 * Strip compile-time absolute path prefixes from stack frame filenames.
 *
 * `deno compile` bakes the build-time CWD into all module paths
 * (e.g. `/tmp/deno-compile-atlas/apps/atlasd/src/atlas-daemon.ts`).
 * Sentry can't resolve these, showing `?` in culprit lines.
 * Rewriting to repo-relative paths makes frames actionable.
 *
 * Uses `beforeSend` instead of `rewriteFramesIntegration` because the
 * built-in integration only processes exception frames — it skips
 * `event.threads` entirely (verified in @sentry/core@10.42.0).
 */
const COMPILE_PATH_PREFIX = /^.*?\/(apps\/|packages\/|tools\/|scripts\/|node_modules\/|examples\/)/;

function stripPrefix(frame: Sentry.StackFrame): void {
  if (frame.filename) {
    frame.filename = frame.filename.replace(COMPILE_PATH_PREFIX, "$1");
  }
  if (frame.abs_path) {
    frame.abs_path = frame.abs_path.replace(COMPILE_PATH_PREFIX, "$1");
  }
}

/** Error types that represent expected operational conditions, not bugs. */
const FILTERED_ERROR_TYPES = new Set(["AbortError", "UserConfigurationError"]);

export function rewriteFrames(event: Sentry.ErrorEvent): Sentry.ErrorEvent | null {
  for (const exc of event.exception?.values ?? []) {
    if (exc.type && FILTERED_ERROR_TYPES.has(exc.type)) {
      return null;
    }
  }

  for (const exception of event.exception?.values ?? []) {
    for (const frame of exception.stacktrace?.frames ?? []) {
      stripPrefix(frame);
    }
  }
  for (const thread of event.threads?.values ?? []) {
    for (const frame of thread.stacktrace?.frames ?? []) {
      stripPrefix(frame);
    }
  }
  return event;
}

export function initSentry(): void {
  if (initialized) return;

  try {
    // Environment from SENTRY_ENVIRONMENT env var, defaults to "local" for local dev
    const environment = env.SENTRY_ENVIRONMENT || "local";

    // Release is embedded at compile time (see compile.sh)
    const release = BUILD_COMMIT;

    Sentry.init({
      dsn: SENTRY_DSN,
      environment,
      release: `atlas@${release}`,
      tracesSampleRate: 1.0,
      sendDefaultPii: true,
      beforeSend: rewriteFrames,
      // Disable denoServeIntegration — its monitorStream() calls reader.releaseLock()
      // after observing reader.closed, which throws in Deno's streams implementation.
      // This crashes the daemon on every SSE response teardown.
      // Re-enable when @sentry/deno fixes: https://github.com/getsentry/sentry-javascript/issues
      integrations: (defaults) => defaults.filter((i) => i.name !== "DenoServe"),
    });

    initialized = true;
    // Using console directly to avoid circular dependency (@atlas/logger imports @atlas/sentry)
    console.info(`[Sentry] Initialized (environment=${environment}, release=${release})`);
  } catch (error) {
    console.warn("[Sentry] Failed to initialize:", error);
    // Don't throw - app should continue without Sentry
  }
}

export async function flush(timeout = 2000): Promise<boolean> {
  if (!initialized) return true;

  try {
    await Sentry.flush(timeout);
    return true;
  } catch {
    return false;
  }
}
