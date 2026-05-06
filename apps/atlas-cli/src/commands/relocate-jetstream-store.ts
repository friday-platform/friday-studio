/**
 * Move legacy JetStream data from `$TMPDIR/nats/jetstream` (where macOS
 * silently garbage-collects $TMPDIR) to the canonical store path.
 *
 * Path semantics — the load-bearing detail this module gets right:
 *   `nats-server -sd <storeDir>` writes streams to
 *   `<storeDir>/jetstream/$G/streams/<name>` (NATS appends a `jetstream/`
 *   segment internally).
 *
 *   - `legacyPath` is the **JetStream root** of the legacy on-disk
 *     layout, NOT the legacy storeDir. Default: `$TMPDIR/nats/jetstream`
 *     — the directory that contains `$G/streams/...` directly. (The
 *     legacy launcher passed `-sd $TMPDIR/nats`, so NATS produced
 *     `$TMPDIR/nats/jetstream/$G/streams/...`.)
 *   - `targetPath` is the **JetStream root** of the canonical layout,
 *     i.e. `<storeDir>/jetstream` where storeDir is whatever the new
 *     launcher passes via `-sd`. Default: `<FRIDAY_JETSTREAM_STORE_DIR
 *     OR <fridayHome>/jetstream>/jetstream`.
 *
 * The probe (`<root>/$G/streams`) and the move treat both paths
 * symmetrically as JetStream roots — moving the legacy root in place
 * leaves a layout NATS can read directly.
 *
 * Idempotent: noop when there's nothing to move (fresh install, already
 * relocated, or target already populated). Safe to run repeatedly.
 */

import { cp, mkdir, readdir, realpath, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import type { Logger } from "@atlas/logger";
import { getFridayHome } from "@atlas/utils/paths.server";

export interface RelocateOverrides {
  legacyPath?: string;
  targetPath?: string;
  rename?: typeof rename;
  cp?: typeof cp;
}

export interface RelocateResult {
  legacyPath: string;
  targetPath: string;
  /** True iff actual data was moved. False on noop / target-already-populated. */
  moved: boolean;
  /** Number of streams under the source at probe time. 0 on noop. */
  streamsMoved: number;
}

interface NodeError extends Error {
  code?: string;
}

function isNodeError(err: unknown): err is NodeError {
  return err instanceof Error && typeof (err as NodeError).code === "string";
}

/** List streams under `<jsRoot>/$G/streams`, or null if missing.
 *  `jsRoot` is the JetStream root — the directory that contains
 *  `$G/streams/<stream-name>` directly (one level under the storeDir
 *  given to `nats-server -sd`). */
async function probeStreams(jsRoot: string): Promise<string[] | null> {
  try {
    return await readdir(join(jsRoot, "$G", "streams"));
  } catch (err) {
    if (isNodeError(err) && (err.code === "ENOENT" || err.code === "ENOTDIR")) {
      return null;
    }
    throw err;
  }
}

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

async function cleanupPartialTarget(target: string): Promise<void> {
  try {
    await rm(target, { recursive: true, force: true });
  } catch {
    // Caller is already in an error path; don't mask the original error.
  }
}

export async function relocateJetStreamStore(
  logger: Logger,
  overrides: RelocateOverrides = {},
): Promise<RelocateResult> {
  // legacyPath: JetStream root of the legacy layout. Old launcher
  // passed `-sd $TMPDIR/nats`, so NATS produced
  // `$TMPDIR/nats/jetstream/$G/streams/...`. The "JetStream root" is
  // therefore $TMPDIR/nats/jetstream — the dir that contains $G/.
  const legacyPath = overrides.legacyPath ?? join(tmpdir(), "nats", "jetstream");
  // targetPath: JetStream root of the canonical layout. The new
  // launcher passes `-sd <storeDir>`, so NATS produces
  // `<storeDir>/jetstream/$G/streams/...`. The JetStream root is
  // <storeDir>/jetstream — one level deeper than storeDir itself.
  const envOverride = process.env.FRIDAY_JETSTREAM_STORE_DIR;
  const storeDir =
    envOverride && envOverride.length > 0 ? envOverride : join(getFridayHome(), "jetstream");
  const targetPath = overrides.targetPath ?? join(storeDir, "jetstream");

  const renameImpl = overrides.rename ?? rename;
  const cpImpl = overrides.cp ?? cp;

  // One log line per invocation, before any filesystem probe — gives
  // support a "where did we look?" record regardless of outcome.
  logger.info("relocate-jetstream-store: resolved paths", { legacyPath, targetPath });

  // Realpath equality — operator may have set FRIDAY_JETSTREAM_STORE_DIR
  // to the legacy $TMPDIR path, or symlinks may collapse to it.
  const legacyReal = await realpathOrNull(legacyPath);
  const targetReal = await realpathOrNull(targetPath);
  if (legacyReal !== null && targetReal !== null && legacyReal === targetReal) {
    return { legacyPath, targetPath, moved: false, streamsMoved: 0 };
  }

  const legacyStreams = await probeStreams(legacyPath);
  if (legacyStreams === null || legacyStreams.length === 0) {
    return { legacyPath, targetPath, moved: false, streamsMoved: 0 };
  }

  const targetStreams = await probeStreams(targetPath);
  if (targetStreams !== null && targetStreams.length > 0) {
    // Don't clobber existing data at the target.
    return { legacyPath, targetPath, moved: false, streamsMoved: targetStreams.length };
  }

  await mkdir(dirname(targetPath), { recursive: true });

  try {
    await renameImpl(legacyPath, targetPath);
  } catch (err) {
    if (!(isNodeError(err) && err.code === "EXDEV")) {
      await cleanupPartialTarget(targetPath);
      throw err;
    }
    // Cross-filesystem fallback: recursive copy + source removal.
    try {
      await cpImpl(legacyPath, targetPath, { recursive: true, errorOnExist: false });
    } catch (copyErr) {
      await cleanupPartialTarget(targetPath);
      throw copyErr;
    }
    await rm(legacyPath, { recursive: true, force: true });
  }

  return { legacyPath, targetPath, moved: true, streamsMoved: legacyStreams.length };
}
