import * as Sentry from "@sentry/deno";
import { BUILD_COMMIT } from "./build-info.ts";

const SENTRY_DSN =
  "https://504477a5bd4822c276fac7593c5c12a1@o4507579070611456.ingest.us.sentry.io/4510468135583744";

let initialized = false;

export function isInitialized(): boolean {
  return initialized;
}

export function initSentry(): void {
  if (initialized) return;

  try {
    // Environment from SENTRY_ENVIRONMENT env var, defaults to "local" for local dev
    const environment = Deno.env.get("SENTRY_ENVIRONMENT") || "local";

    // Release is embedded at compile time (see compile.sh)
    const release = BUILD_COMMIT;

    Sentry.init({
      dsn: SENTRY_DSN,
      environment,
      release: `atlas@${release}`,
      tracesSampleRate: 1.0,
      sendDefaultPii: true,
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
