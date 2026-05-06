/**
 * Tests for the pre-NATS PID-file lock helper. Each test uses an
 * isolated `mkdtemp`-style fixture directory so concurrent runners don't
 * step on each other.
 */

import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquirePreNatsLock, LockBusyError } from "./lock.ts";

const LOCK_FILENAME = ".pre-nats-migrate.lock";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "pre-nats-lock-test-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true }).catch(() => {});
});

describe("acquirePreNatsLock", () => {
  it("acquires on empty state and writes current pid", async () => {
    const handle = await acquirePreNatsLock(home);
    const lockPath = join(home, LOCK_FILENAME);
    const contents = await readFile(lockPath, "utf8");
    expect(contents.trim()).toBe(String(process.pid));
    await handle.release();
  });

  it("throws LockBusyError when a live PID holds the lock", async () => {
    // Use the current process's pid as the holder — it's definitely alive.
    const lockPath = join(home, LOCK_FILENAME);
    await writeFile(lockPath, String(process.pid));

    let caught: unknown;
    try {
      await acquirePreNatsLock(home);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LockBusyError);
    if (caught instanceof LockBusyError) {
      expect(caught.holderPid).toBe(process.pid);
      expect(caught.message).toContain(String(process.pid));
      expect(caught.message).toContain("another pre-NATS migration is in progress");
    }
  });

  it("takes over a stale lock from a dead PID", async () => {
    // PID 999999 is virtually guaranteed not to exist on a real system.
    // process.kill(999999, 0) will throw ESRCH, marking it as dead.
    const lockPath = join(home, LOCK_FILENAME);
    await writeFile(lockPath, "999999");

    const handle = await acquirePreNatsLock(home);
    const contents = await readFile(lockPath, "utf8");
    expect(contents.trim()).toBe(String(process.pid));
    await handle.release();
  });

  it("release() removes the lock file", async () => {
    const handle = await acquirePreNatsLock(home);
    const lockPath = join(home, LOCK_FILENAME);
    await handle.release();
    let exists = true;
    try {
      await stat(lockPath);
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });

  it("release() is idempotent when the lock file is already gone", async () => {
    const handle = await acquirePreNatsLock(home);
    const lockPath = join(home, LOCK_FILENAME);
    // Pre-emptively delete so release sees ENOENT.
    await rm(lockPath);
    await expect(handle.release()).resolves.toBeUndefined();
  });

  it("treats an unparseable lock file as stale and takes over", async () => {
    const lockPath = join(home, LOCK_FILENAME);
    await writeFile(lockPath, "not-a-pid-at-all");
    const handle = await acquirePreNatsLock(home);
    const contents = await readFile(lockPath, "utf8");
    expect(contents.trim()).toBe(String(process.pid));
    await handle.release();
  });
});
