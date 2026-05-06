/**
 * PID-file lock for pre-NATS migrations.
 *
 * Pre-NATS work has no NATS connection, so the existing KV-bucket lock
 * (`packages/jetstream/src/migrations.ts`) is unavailable. Instead we use
 * an `O_EXCL` PID file at `<friday_home>/.pre-nats-migrate.lock`.
 *
 * Stale-lock detection: if the file exists, read the holder PID and ping
 * it via `process.kill(pid, 0)`. The signal `0` does not actually deliver
 * a signal — it just exercises the kernel's permission/existence check.
 * If the holder is dead the call throws (typically ESRCH); if it is alive
 * the call returns silently. On a stale lock we unlink and retry once.
 *
 * Lifecycle: the CLI handler acquires the lock immediately before
 * `runPreNatsMigrations`, releases it in a `finally` immediately after —
 * before `connectOrSpawn` is called. Post-NATS migrations rely on their
 * own KV lock, so the two locks have non-overlapping scopes.
 */

import { open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

const LOCK_FILENAME = ".pre-nats-migrate.lock";

/** Thrown when another live process holds the pre-NATS lock. */
export class LockBusyError extends Error {
  /** PID of the live process currently holding the lock. */
  public readonly holderPid: number;

  constructor(message: string, holderPid: number) {
    super(message);
    this.name = "LockBusyError";
    this.holderPid = holderPid;
  }
}

/** Handle returned by `acquirePreNatsLock`. Calling `release()` is
 *  idempotent (safe to call when the file is already gone). */
export interface LockHandle {
  release(): Promise<void>;
}

interface NodeError extends Error {
  code?: string;
}

function isNodeError(err: unknown): err is NodeError {
  return err instanceof Error && typeof (err as NodeError).code === "string";
}

/** Returns true if `pid` corresponds to a process the current user can
 *  signal (i.e. a live process — `process.kill(pid, 0)` returns silently
 *  for live processes and throws ESRCH for dead ones). EPERM also means
 *  the process exists, just owned by another user; we treat that as
 *  alive (conservative — refuse the lock). */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (isNodeError(err) && err.code === "EPERM") {
      return true;
    }
    return false;
  }
}

async function tryCreateLockFile(path: string): Promise<boolean> {
  try {
    // 'wx' = O_WRONLY | O_CREAT | O_EXCL — atomic exclusive create.
    const handle = await open(path, "wx");
    try {
      await handle.writeFile(String(process.pid));
    } finally {
      await handle.close();
    }
    return true;
  } catch (err) {
    if (isNodeError(err) && err.code === "EEXIST") {
      return false;
    }
    throw err;
  }
}

async function readHolderPid(path: string): Promise<number | null> {
  try {
    const raw = (await readFile(path, "utf8")).trim();
    const pid = Number.parseInt(raw, 10);
    if (!Number.isFinite(pid) || pid <= 0) return null;
    return pid;
  } catch (err) {
    if (isNodeError(err) && err.code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

async function unlinkIgnoreEnoent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (err) {
    if (isNodeError(err) && err.code === "ENOENT") return;
    throw err;
  }
}

function busyMessage(pid: number): string {
  return (
    `another pre-NATS migration is in progress (pid ${pid}); ` +
    `wait for it to finish or kill it manually`
  );
}

/**
 * Acquire the pre-NATS PID lock. Resolves with a handle whose `release()`
 * unlinks the file. Throws `LockBusyError` if another live process holds
 * it. Stale locks (PID file present but holder dead) are taken over
 * automatically by unlinking and retrying once.
 */
export async function acquirePreNatsLock(home: string): Promise<LockHandle> {
  const path = join(home, LOCK_FILENAME);

  if (await tryCreateLockFile(path)) {
    return { release: () => unlinkIgnoreEnoent(path) };
  }

  // Lock file exists. Inspect the holder.
  const holderPid = await readHolderPid(path);

  if (holderPid === null) {
    // File exists but is unreadable / unparseable. Treat as stale and
    // take over (single retry).
    await unlinkIgnoreEnoent(path);
    if (await tryCreateLockFile(path)) {
      return { release: () => unlinkIgnoreEnoent(path) };
    }
    // Someone else won the race. Re-read the holder to surface the
    // PID we lost to.
    const racePid = (await readHolderPid(path)) ?? -1;
    throw new LockBusyError(busyMessage(racePid), racePid);
  }

  if (isPidAlive(holderPid)) {
    throw new LockBusyError(busyMessage(holderPid), holderPid);
  }

  // Stale lock: holder is dead. Take over.
  await unlinkIgnoreEnoent(path);
  if (await tryCreateLockFile(path)) {
    return { release: () => unlinkIgnoreEnoent(path) };
  }
  // Lost the race after the take-over. Surface the new holder.
  const racePid = (await readHolderPid(path)) ?? -1;
  throw new LockBusyError(busyMessage(racePid), racePid);
}
