/**
 * Reactive Studio update-status store.
 *
 * Owns the in-memory `UpdateStatus` populated via `GET /api/updates`, the
 * 24h banner-dismiss state in `localStorage`, and the manual-check rate-limit
 * window. The banner and Settings panel both read from here.
 *
 * @module
 */

import { logger } from "@atlas/logger/console";
import { z } from "zod";
import { getClient } from "./client.ts";
import type { UpdateStatus } from "./server/lib/update-checker.ts";

const DISMISS_KEY = "studio-update-banner-dismiss";
const DISMISS_WINDOW_MS = 24 * 60 * 60 * 1000;
const CHECK_WINDOW_MS = 10_000;

const DismissSchema = z.object({
  version: z.string(),
  until: z.number(),
});
type Dismiss = z.infer<typeof DismissSchema>;

function emptyStatus(): UpdateStatus {
  return {
    current: "",
    latest: null,
    outOfDate: false,
    lastCheckedAt: null,
    lastSuccessAt: null,
    error: null,
    isDev: false,
  };
}

// Svelte 5 $state() runes require `let` for reactivity even when only
// the contained fields mutate.
/* eslint-disable prefer-const */
// deno-lint-ignore prefer-const
let status: UpdateStatus = $state(emptyStatus());
// `dismiss` is loaded lazily on first read of `bannerDismissed.value` —
// not at module-import time. Reading localStorage at import time hits
// Deno's SQLite-backed storage and can throw `database is locked` when
// parallel test workers all import this module at once. Deferring also
// matches the contract of the rest of this module: `loadUpdateStatus`
// is the explicit "do I/O now" entry point.
// deno-lint-ignore prefer-const
let dismiss: Dismiss | null = $state(null);
let dismissLoadAttempted = false;
// deno-lint-ignore prefer-const
let now: number = $state(Date.now());
// deno-lint-ignore prefer-const
let checking: boolean = $state(false);
// deno-lint-ignore prefer-const
let checkWindowEndsAt: number | null = $state(null);
// deno-lint-ignore prefer-const
let lastCheckedJustNow: boolean = $state(false);
/* eslint-enable prefer-const */

let loaded = false;
let nowTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Pure predicate for "is the banner currently dismissed?". Exposed for tests
 * so the dismissal-window + version-invalidation logic can be exercised
 * without standing up Svelte runes.
 */
export function isDismissed(
  dismissal: { version: string; until: number } | null,
  latestVersion: string | null,
  nowMs: number,
): boolean {
  if (!dismissal) return false;
  if (latestVersion === null) return false;
  if (dismissal.version !== latestVersion) return false;
  return nowMs < dismissal.until;
}

function loadDismiss(): Dismiss | null {
  if (typeof localStorage === "undefined") return null;
  let raw: string | null;
  try {
    raw = localStorage.getItem(DISMISS_KEY);
  } catch (err) {
    // localStorage I/O failed — Deno's SQLite-backed storage hits WAL
    // lock contention in CI, browsers can throw on disabled storage or
    // quota issues. Treat as "no dismissal"; the banner reappearing is
    // a benign degradation.
    logger.warn("update-status: localStorage read failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = DismissSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch {
    // JSON.parse failed — fall through to cleanup below.
  }
  // Best-effort tidy of a corrupt entry; tolerate failure.
  try {
    localStorage.removeItem(DISMISS_KEY);
  } catch {
    /* ignore */
  }
  return null;
}

/** Read `dismiss` from storage on first access; cached afterward. */
function ensureDismissLoaded(): void {
  if (dismissLoadAttempted) return;
  dismissLoadAttempted = true;
  dismiss = loadDismiss();
}

function ensureClock(): void {
  if (nowTimer !== null) return;
  if (typeof globalThis === "undefined") return;
  nowTimer = setInterval(() => {
    now = Date.now();
  }, 1_000);
}

/** Reactive snapshot of the current update status. */
export const updateStatus: UpdateStatus = status;

/**
 * Reactive boolean: true iff the user dismissed the banner for the current
 * `latest` version and the 24h window hasn't elapsed. A newer `latest`
 * silently invalidates an older dismissal.
 */
export const bannerDismissed = {
  get value(): boolean {
    ensureDismissLoaded();
    return isDismissed(dismiss, status.latest, now);
  },
};

/** Reactive boolean: the manual "Check for updates" button is in its 10s window. */
export const checkInFlight = {
  get value(): boolean {
    return checking || (checkWindowEndsAt !== null && now < checkWindowEndsAt);
  },
};

/** Reactive boolean: between response landing and window expiry. */
export const justChecked = {
  get value(): boolean {
    return lastCheckedJustNow && checkWindowEndsAt !== null && now < checkWindowEndsAt;
  },
};

/** Mount-time loader. Idempotent. */
export async function loadUpdateStatus(): Promise<void> {
  ensureClock();
  if (loaded) return;
  loaded = true;
  await refreshFromServer();
}

/** Fetches `GET /api/updates` and updates the store. Errors are logged, not thrown. */
export async function refreshFromServer(): Promise<void> {
  try {
    const res = await getClient().api.updates.$get();
    if (!res.ok) {
      logger.warn("update-status fetch failed", { status: res.status });
      return;
    }
    const body = await res.json();
    Object.assign(status, body);
  } catch (err) {
    logger.warn("update-status fetch threw", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Dismisses the banner for 24h, keyed to the current `latest` version. */
export function dismissBanner(): void {
  if (status.latest === null) return;
  const next: Dismiss = { version: status.latest, until: Date.now() + DISMISS_WINDOW_MS };
  dismiss = next;
  // Mark loaded — writing past the lazy-load is the source of truth now.
  dismissLoadAttempted = true;
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.setItem(DISMISS_KEY, JSON.stringify(next));
    } catch (err) {
      // I/O failed — in-memory `dismiss` still hides the banner for the
      // current session; persistence across reloads is best-effort.
      logger.warn("update-status: localStorage write failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Manual-check helper. Disables the button for 10s total: posts immediately,
 * shows "Checking…" until response, then "Last checked: just now" until the
 * 10s window from the click expires.
 */
export async function checkNow(): Promise<void> {
  if (checkInFlight.value) return;
  ensureClock();
  const startedAt = Date.now();
  checking = true;
  lastCheckedJustNow = false;
  checkWindowEndsAt = startedAt + CHECK_WINDOW_MS;
  try {
    const res = await getClient().api.updates.check.$post();
    if (res.ok) {
      const body = await res.json();
      Object.assign(status, body);
    } else {
      logger.warn("update-status manual check failed", { status: res.status });
    }
  } catch (err) {
    logger.warn("update-status manual check threw", {
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    checking = false;
    lastCheckedJustNow = true;
    setTimeout(() => {
      lastCheckedJustNow = false;
      checkWindowEndsAt = null;
    }, Math.max(0, CHECK_WINDOW_MS - (Date.now() - startedAt)));
  }
}
