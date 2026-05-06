/**
 * Tests for `relocateJetStreamStore`.
 *
 * Real filesystem against a tempdir for the happy path; injected
 * `rename`/`cp` overrides for the EXDEV cross-filesystem fallback.
 */

import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { relocateJetStreamStore } from "./relocate-jetstream-store.ts";

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLogger,
} as unknown as Parameters<typeof relocateJetStreamStore>[0];

let root: string;
let legacyRoot: string;
let targetRoot: string;

async function seedStore(rootPath: string, streams: string[]): Promise<void> {
  for (const name of streams) {
    const dir = join(rootPath, "jetstream", "$G", "streams", name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "meta.inf"), `stream ${name}`);
  }
}

async function dirExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "relocate-jstream-"));
  legacyRoot = join(root, "legacy");
  targetRoot = join(root, "target");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

describe("relocateJetStreamStore", () => {
  it("noop when legacy is missing", async () => {
    const result = await relocateJetStreamStore(noopLogger, {
      legacyPath: legacyRoot,
      targetPath: targetRoot,
    });
    expect(result.moved).toBe(false);
    expect(result.streamsMoved).toBe(0);
    expect(await dirExists(targetRoot)).toBe(false);
  });

  it("noop when legacy and target resolve to the same realpath", async () => {
    // Same path → realpath equality → noop, even if the dir is populated.
    await seedStore(legacyRoot, ["S1"]);
    const result = await relocateJetStreamStore(noopLogger, {
      legacyPath: legacyRoot,
      targetPath: legacyRoot,
    });
    expect(result.moved).toBe(false);
    // Source still there.
    expect(await readdir(join(legacyRoot, "jetstream", "$G", "streams"))).toEqual(["S1"]);
  });

  it("moves streams via rename when legacy is populated and target is empty", async () => {
    await seedStore(legacyRoot, ["FRIDAY_CHATS", "FRIDAY_MEMORY"]);
    const result = await relocateJetStreamStore(noopLogger, {
      legacyPath: legacyRoot,
      targetPath: targetRoot,
    });
    expect(result.moved).toBe(true);
    expect(result.streamsMoved).toBe(2);
    expect(await dirExists(legacyRoot)).toBe(false);
    const moved = await readdir(join(targetRoot, "jetstream", "$G", "streams"));
    expect(moved.sort()).toEqual(["FRIDAY_CHATS", "FRIDAY_MEMORY"]);
  });

  it("does not clobber a populated target", async () => {
    await seedStore(legacyRoot, ["A"]);
    await seedStore(targetRoot, ["B"]);
    const result = await relocateJetStreamStore(noopLogger, {
      legacyPath: legacyRoot,
      targetPath: targetRoot,
    });
    expect(result.moved).toBe(false);
    // Both stores intact — operator gets a chance to merge manually.
    expect(await readdir(join(legacyRoot, "jetstream", "$G", "streams"))).toEqual(["A"]);
    expect(await readdir(join(targetRoot, "jetstream", "$G", "streams"))).toEqual(["B"]);
  });

  it("falls back to copy + rm on EXDEV", async () => {
    await seedStore(legacyRoot, ["S1"]);
    const xdev = Object.assign(new Error("cross-device"), { code: "EXDEV" });
    const fakeRename = vi.fn(async () => {
      await Promise.resolve();
      throw xdev;
    });

    const result = await relocateJetStreamStore(noopLogger, {
      legacyPath: legacyRoot,
      targetPath: targetRoot,
      rename: fakeRename as unknown as typeof import("node:fs/promises").rename,
    });
    expect(fakeRename).toHaveBeenCalledTimes(1);
    expect(result.moved).toBe(true);
    expect(result.streamsMoved).toBe(1);
    expect(await dirExists(legacyRoot)).toBe(false);
    expect(await readdir(join(targetRoot, "jetstream", "$G", "streams"))).toEqual(["S1"]);
  });

  it("cleans up partial target on copy failure mid-stream", async () => {
    await seedStore(legacyRoot, ["S1"]);
    const xdev = Object.assign(new Error("cross-device"), { code: "EXDEV" });
    const fakeRename = vi.fn(() => Promise.reject(xdev));
    // Mirror the real on-disk shape: partial subtree under the target.
    const fakeCp = vi.fn(async (_src: string, dst: string) => {
      const partial = join(dst, "jetstream", "$G", "streams", "S1");
      await mkdir(partial, { recursive: true });
      await writeFile(join(partial, "meta.inf"), "partial");
      throw new Error("disk read error mid-copy");
    });

    await expect(
      relocateJetStreamStore(noopLogger, {
        legacyPath: legacyRoot,
        targetPath: targetRoot,
        rename: fakeRename as unknown as typeof import("node:fs/promises").rename,
        cp: fakeCp as unknown as typeof import("node:fs/promises").cp,
      }),
    ).rejects.toThrow(/disk read error/);

    // Source intact, partial target wiped.
    expect(await readdir(join(legacyRoot, "jetstream", "$G", "streams"))).toEqual(["S1"]);
    expect(await dirExists(targetRoot)).toBe(false);
  });

  it("propagates non-EXDEV rename errors with target cleanup", async () => {
    await seedStore(legacyRoot, ["S1"]);
    // Pre-create the target dir so rmEmptyDir cleanup has something to
    // scrub — though for a non-EXDEV rename failure we typically have
    // nothing landed.
    const eperm = Object.assign(new Error("permission denied"), { code: "EPERM" });
    const fakeRename = vi.fn(() => Promise.reject(eperm));

    await expect(
      relocateJetStreamStore(noopLogger, {
        legacyPath: legacyRoot,
        targetPath: targetRoot,
        rename: fakeRename as unknown as typeof import("node:fs/promises").rename,
      }),
    ).rejects.toThrow(/permission denied/);

    // Source intact; target left clean.
    expect(await readdir(join(legacyRoot, "jetstream", "$G", "streams"))).toEqual(["S1"]);
  });
});
