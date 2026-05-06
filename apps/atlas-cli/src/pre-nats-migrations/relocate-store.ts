/**
 * relocate-jetstream-store — the only pre-NATS migration in the registry
 * (today). Detects legacy data at `$TMPDIR/nats/jetstream` and moves it to
 * `<FRIDAY_JETSTREAM_STORE_DIR>` (or `<friday_home>/jetstream` if unset).
 *
 * Idempotent and a no-op for fresh installs:
 * - empty legacy dir → status: noop, target untouched
 * - legacy and target resolve to the same realpath → status: legacy_equals_target
 * - target already populated → status: skipped (reason: dest_not_empty)
 * - legacy populated, target empty → rename (or copy-fallback on EXDEV)
 *
 * Logging discipline: emits exactly one structured `info` line at the
 * start of `run()` — before any filesystem probe — with the resolved
 * paths. `@atlas/logger`'s `info` level calls `console.info`, which in
 * Node/Deno writes to **stdout** (only `console.error`/`console.warn`
 * go to stderr). The migrate handler emits its outcome JSON LAST on
 * stdout, so the installer's Tauri wrapper picks it via a backward
 * scan and ignores any earlier logger lines without needing to know
 * the outcome schema.
 */

import { cp, mkdir, readdir, realpath, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { getFridayHome } from "@atlas/utils/paths.server";
import type {
  ErrorKind,
  MigrationOutcome,
  PreNatsContext,
  PreNatsMigration,
  TargetSource,
} from "./types.ts";

interface NodeError extends Error {
  code?: string;
}

function isNodeError(err: unknown): err is NodeError {
  return err instanceof Error && typeof (err as NodeError).code === "string";
}

/** Map a Node fs error code to one of the documented `ErrorKind` tags. */
function classifyError(code: string | undefined): ErrorKind {
  switch (code) {
    case "EACCES":
    case "EPERM":
      return "permission_denied";
    case "ENOSPC":
      return "disk_full";
    case "EXDEV":
      return "copy_failed";
    default:
      return "unknown";
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Probe the JetStream stream directory at the given store root.
 * The on-disk shape NATS produces is `<storeDir>/jetstream/$G/streams`.
 * Returns the list of stream entries (possibly empty), or null if any
 * level of the path is missing.
 */
async function probeStreams(storeRoot: string): Promise<string[] | null> {
  const streamsDir = join(storeRoot, "jetstream", "$G", "streams");
  try {
    return await readdir(streamsDir);
  } catch (err) {
    if (isNodeError(err) && (err.code === "ENOENT" || err.code === "ENOTDIR")) {
      return null;
    }
    throw err;
  }
}

/**
 * Resolve realpath, returning null on ENOENT (the path doesn't exist).
 * Other errors propagate — they indicate a real problem worth surfacing.
 */
async function realpathOrNull(p: string): Promise<string | null> {
  try {
    return await realpath(p);
  } catch (err) {
    if (isNodeError(err) && (err.code === "ENOENT" || err.code === "ENOTDIR")) {
      return null;
    }
    throw err;
  }
}

/** Best-effort cleanup of a partial copy at `target`. Swallows errors —
 *  the caller is already in an error path. */
async function cleanupPartialTarget(target: string): Promise<void> {
  try {
    await rm(target, { recursive: true, force: true });
  } catch {
    // Caller is already reporting a failure; don't mask it.
  }
}

/** Ensure parent dir exists (mkdir -p). Returns the existing or freshly
 *  created path. */
async function ensureParentDir(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
}

/**
 * Path-resolution overrides for testing. Production callers don't pass
 * any of these — the defaults read `os.tmpdir()` and the env-var. Tests
 * inject explicit paths so the move targets a fixture directory rather
 * than the real `$TMPDIR`.
 */
export interface RelocateOverrides {
  legacyPath?: string;
  targetPath?: string;
  targetSource?: TargetSource;
  /** Optional override for `fs.rename`. Tests use this to simulate EXDEV. */
  rename?: typeof rename;
  /** Optional override for `fs.cp` (the copy-fallback). Tests use this to
   *  inject mid-copy failures. */
  cp?: typeof cp;
}

export async function runRelocate(
  ctx: PreNatsContext,
  overrides: RelocateOverrides = {},
): Promise<MigrationOutcome> {
  const startedAt = Date.now();
  const id = "relocate-jetstream-store";

  const legacyPath = overrides.legacyPath ?? join(tmpdir(), "nats", "jetstream");
  const envOverride = process.env.FRIDAY_JETSTREAM_STORE_DIR;
  const targetPath =
    overrides.targetPath ??
    (envOverride && envOverride.length > 0 ? envOverride : join(getFridayHome(), "jetstream"));
  const targetSource: TargetSource =
    overrides.targetSource ?? (envOverride && envOverride.length > 0 ? "env" : "default");

  const renameImpl = overrides.rename ?? rename;
  const cpImpl = overrides.cp ?? cp;

  // Resolved-paths log — fires on EVERY invocation (noop, dry-run, error,
  // success), exactly once per call, before any filesystem probe. Lands
  // on stdout (Node/Deno's console.info target); the migrate handler
  // emits its outcome JSON LAST so this earlier logger line doesn't
  // confuse the installer's backward-scan parser.
  ctx.logger.info("pre-nats migration: relocate-jetstream-store", {
    id,
    legacy_path: legacyPath,
    target_path: targetPath,
    target_source: targetSource,
    dry_run: ctx.dryRun,
  });

  const baseOutcome = {
    id,
    legacy_path: legacyPath,
    target_path: targetPath,
    target_source: targetSource,
  };

  // Realpath comparison — operator may have set FRIDAY_JETSTREAM_STORE_DIR
  // to the legacy $TMPDIR path, or symlinks may make them resolve to the
  // same place. Either way: nothing to move.
  try {
    const legacyReal = await realpathOrNull(legacyPath);
    const targetReal = await realpathOrNull(targetPath);
    if (legacyReal !== null && targetReal !== null && legacyReal === targetReal) {
      return {
        ...baseOutcome,
        status: "legacy_equals_target",
        duration_ms: Date.now() - startedAt,
      };
    }
  } catch (err) {
    return {
      ...baseOutcome,
      status: "error",
      error: {
        kind: classifyError(isNodeError(err) ? err.code : undefined),
        message: errorMessage(err),
      },
      duration_ms: Date.now() - startedAt,
    };
  }

  // Probe legacy. ENOENT or empty → noop (fresh install or already-migrated).
  let legacyStreams: string[] | null;
  try {
    legacyStreams = await probeStreams(legacyPath);
  } catch (err) {
    return {
      ...baseOutcome,
      status: "error",
      error: {
        kind: classifyError(isNodeError(err) ? err.code : undefined),
        message: errorMessage(err),
      },
      duration_ms: Date.now() - startedAt,
    };
  }

  if (legacyStreams === null || legacyStreams.length === 0) {
    return {
      ...baseOutcome,
      status: "noop",
      streams_moved: 0,
      duration_ms: Date.now() - startedAt,
    };
  }

  // Probe target. Non-empty → skipped (don't clobber).
  let targetStreams: string[] | null;
  try {
    targetStreams = await probeStreams(targetPath);
  } catch (err) {
    return {
      ...baseOutcome,
      status: "error",
      error: {
        kind: classifyError(isNodeError(err) ? err.code : undefined),
        message: errorMessage(err),
      },
      duration_ms: Date.now() - startedAt,
    };
  }

  if (targetStreams !== null && targetStreams.length > 0) {
    return {
      ...baseOutcome,
      status: "skipped",
      reason: "dest_not_empty",
      streams_moved: targetStreams.length,
      duration_ms: Date.now() - startedAt,
    };
  }

  // Dry run: report intent without mutating. The resolved-paths log
  // already emitted captures what would happen.
  if (ctx.dryRun) {
    return {
      ...baseOutcome,
      status: "migrated",
      streams_moved: legacyStreams.length,
      duration_ms: Date.now() - startedAt,
    };
  }

  // Real run: ensure parent of target exists, then rename. On EXDEV (cross
  // filesystem rename) fall back to recursive copy + source removal.
  try {
    await ensureParentDir(targetPath);

    let renamed = false;
    try {
      await renameImpl(legacyPath, targetPath);
      renamed = true;
    } catch (err) {
      if (!(isNodeError(err) && err.code === "EXDEV")) {
        throw err;
      }
    }

    if (!renamed) {
      // Cross-filesystem fallback. Copy first, then remove the source.
      // Any failure mid-copy cleans up the partial target so the source
      // remains the authoritative copy.
      try {
        await cpImpl(legacyPath, targetPath, { recursive: true, errorOnExist: false });
      } catch (copyErr) {
        await cleanupPartialTarget(targetPath);
        return {
          ...baseOutcome,
          status: "error",
          error: { kind: "copy_failed", message: errorMessage(copyErr) },
          duration_ms: Date.now() - startedAt,
        };
      }
      try {
        await rm(legacyPath, { recursive: true, force: true });
      } catch (rmErr) {
        // Copy succeeded, source removal failed. The target has the
        // authoritative data; surface the partial outcome as an error
        // with the original kind so support sees something actionable.
        return {
          ...baseOutcome,
          status: "error",
          error: {
            kind: classifyError(isNodeError(rmErr) ? rmErr.code : undefined),
            message: `copied but failed to remove source: ${errorMessage(rmErr)}`,
          },
          duration_ms: Date.now() - startedAt,
        };
      }
    }
  } catch (err) {
    // Top-level failure (e.g. ensureParentDir failing, or rename failing
    // with a non-EXDEV code). If anything landed at the target, clean it
    // up so the source remains authoritative.
    await cleanupPartialTarget(targetPath);
    return {
      ...baseOutcome,
      status: "error",
      error: {
        kind: classifyError(isNodeError(err) ? err.code : undefined),
        message: errorMessage(err),
      },
      duration_ms: Date.now() - startedAt,
    };
  }

  return {
    ...baseOutcome,
    status: "migrated",
    streams_moved: legacyStreams.length,
    duration_ms: Date.now() - startedAt,
  };
}

export const relocateStore: PreNatsMigration = {
  id: "relocate-jetstream-store",
  name: "Relocate JetStream store from $TMPDIR",
  description:
    "Detect legacy JetStream data at $TMPDIR/nats/jetstream and move it to " +
    "the canonical FRIDAY_JETSTREAM_STORE_DIR (defaults to <friday_home>/jetstream).",
  run: runRelocate,
};
