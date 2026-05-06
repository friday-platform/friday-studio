/**
 * Tests for the relocate-jetstream-store pre-NATS migration.
 *
 * Each test prepares a fixture pair of directories — a legacy "store
 * root" (mock $TMPDIR/nats/jetstream) and a target — and exercises
 * `runRelocate` with explicit path overrides. The test never touches the
 * real `$TMPDIR/nats/...` location.
 */

import { mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "@atlas/logger";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runRelocate } from "./relocate-store.ts";

let fixtureRoot: string;
let legacyRoot: string;
let targetRoot: string;

function createCapturingLogger(): {
  logger: Logger;
  infoCalls: { message: string; context: Record<string, unknown> }[];
} {
  const infoCalls: { message: string; context: Record<string, unknown> }[] = [];
  // Cast through unknown — the real Logger interface includes a `child`
  // method we don't need for these tests.
  const logger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: (message: string, context?: Record<string, unknown>) => {
      infoCalls.push({ message, context: context ?? {} });
    },
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  } as unknown as Logger;
  return { logger, infoCalls };
}

/** Populate `<root>/jetstream/$G/streams/<name>` with one file each. */
async function seedStore(root: string, streamNames: string[]): Promise<void> {
  for (const name of streamNames) {
    const dir = join(root, "jetstream", "$G", "streams", name);
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
  fixtureRoot = await mkdtemp(join(tmpdir(), "relocate-store-test-"));
  legacyRoot = join(fixtureRoot, "legacy");
  targetRoot = join(fixtureRoot, "target");
});

afterEach(async () => {
  await rm(fixtureRoot, { recursive: true, force: true }).catch(() => {});
});

describe("runRelocate", () => {
  it("noop when legacy is missing entirely", async () => {
    const { logger, infoCalls } = createCapturingLogger();
    const outcome = await runRelocate(
      { logger, dryRun: false },
      { legacyPath: legacyRoot, targetPath: targetRoot, targetSource: "default" },
    );
    expect(outcome.status).toBe("noop");
    expect(outcome.streams_moved).toBe(0);
    expect(await dirExists(targetRoot)).toBe(false);
    // Resolved-paths log fires exactly once.
    expect(infoCalls).toHaveLength(1);
    expect(infoCalls[0]?.context).toMatchObject({
      id: "relocate-jetstream-store",
      legacy_path: legacyRoot,
      target_path: targetRoot,
      target_source: "default",
      dry_run: false,
    });
  });

  it("noop when legacy directory exists but is empty", async () => {
    await mkdir(join(legacyRoot, "jetstream", "$G", "streams"), { recursive: true });
    const { logger } = createCapturingLogger();
    const outcome = await runRelocate(
      { logger, dryRun: false },
      { legacyPath: legacyRoot, targetPath: targetRoot, targetSource: "default" },
    );
    expect(outcome.status).toBe("noop");
  });

  it("migrates when legacy populated and target empty", async () => {
    await seedStore(legacyRoot, ["FRIDAY_CHATS", "FRIDAY_MEMORY"]);
    const { logger } = createCapturingLogger();
    const outcome = await runRelocate(
      { logger, dryRun: false },
      { legacyPath: legacyRoot, targetPath: targetRoot, targetSource: "default" },
    );
    expect(outcome.status).toBe("migrated");
    expect(outcome.streams_moved).toBe(2);
    expect(outcome.bytes_moved ?? 0).toBeGreaterThan(0);
    // Source is gone; target has the data.
    expect(await dirExists(legacyRoot)).toBe(false);
    const movedStreams = await readdir(join(targetRoot, "jetstream", "$G", "streams"));
    expect(movedStreams.sort()).toEqual(["FRIDAY_CHATS", "FRIDAY_MEMORY"]);
  });

  it("skipped when target already populated", async () => {
    await seedStore(legacyRoot, ["A"]);
    await seedStore(targetRoot, ["B"]);
    const { logger } = createCapturingLogger();
    const outcome = await runRelocate(
      { logger, dryRun: false },
      { legacyPath: legacyRoot, targetPath: targetRoot, targetSource: "env" },
    );
    expect(outcome.status).toBe("skipped");
    expect(outcome.reason).toBe("dest_not_empty");
    // Both preserved.
    expect(await readdir(join(legacyRoot, "jetstream", "$G", "streams"))).toEqual(["A"]);
    expect(await readdir(join(targetRoot, "jetstream", "$G", "streams"))).toEqual(["B"]);
  });

  it("legacy_equals_target when realpaths match (via symlink)", async () => {
    // Create the real directory at targetRoot, populate it, then make
    // legacyRoot a symlink to targetRoot. Realpath comparison should hit.
    await seedStore(targetRoot, ["X"]);
    await symlink(targetRoot, legacyRoot);
    const { logger } = createCapturingLogger();
    const outcome = await runRelocate(
      { logger, dryRun: false },
      { legacyPath: legacyRoot, targetPath: targetRoot, targetSource: "env" },
    );
    expect(outcome.status).toBe("legacy_equals_target");
    // No mutation: original target stream still present, symlink still
    // resolves to it.
    expect(await readdir(join(targetRoot, "jetstream", "$G", "streams"))).toEqual(["X"]);
  });

  it("falls back to copy on EXDEV and removes source", async () => {
    await seedStore(legacyRoot, ["S1"]);
    const { logger } = createCapturingLogger();
    const xdev = Object.assign(new Error("cross-device"), { code: "EXDEV" });
    const fakeRename = vi.fn(async () => {
      await Promise.resolve();
      throw xdev;
    });
    const outcome = await runRelocate(
      { logger, dryRun: false },
      {
        legacyPath: legacyRoot,
        targetPath: targetRoot,
        targetSource: "default",
        rename: fakeRename as unknown as typeof import("node:fs/promises").rename,
      },
    );
    expect(fakeRename).toHaveBeenCalledTimes(1);
    expect(outcome.status).toBe("migrated");
    expect(outcome.streams_moved).toBe(1);
    expect(await dirExists(legacyRoot)).toBe(false);
    expect(await readdir(join(targetRoot, "jetstream", "$G", "streams"))).toEqual(["S1"]);
    // bytes_moved populated from the copied target.
    expect(outcome.bytes_moved ?? 0).toBeGreaterThan(0);
  });

  it("error + cleanup when copy fails mid-stream", async () => {
    await seedStore(legacyRoot, ["S1"]);
    const { logger } = createCapturingLogger();
    const xdev = Object.assign(new Error("cross-device"), { code: "EXDEV" });
    const fakeRename = vi.fn(async () => {
      await Promise.resolve();
      throw xdev;
    });
    const fakeCp = vi.fn(async (_src: string, dst: string) => {
      // Simulate a partial copy: create something at the target then fail.
      await mkdir(dst, { recursive: true });
      await writeFile(join(dst, "partial-marker"), "in progress");
      throw new Error("disk read error mid-copy");
    });
    const outcome = await runRelocate(
      { logger, dryRun: false },
      {
        legacyPath: legacyRoot,
        targetPath: targetRoot,
        targetSource: "default",
        rename: fakeRename as unknown as typeof import("node:fs/promises").rename,
        cp: fakeCp as unknown as typeof import("node:fs/promises").cp,
      },
    );
    expect(outcome.status).toBe("error");
    expect(outcome.error?.kind).toBe("copy_failed");
    // Source intact.
    expect(await readdir(join(legacyRoot, "jetstream", "$G", "streams"))).toEqual(["S1"]);
    // Partial target cleaned up (rm -rf'd).
    expect(await dirExists(targetRoot)).toBe(false);
  });

  it("dry-run reports without mutating", async () => {
    await seedStore(legacyRoot, ["DR1", "DR2"]);
    const { logger, infoCalls } = createCapturingLogger();
    const outcome = await runRelocate(
      { logger, dryRun: true },
      { legacyPath: legacyRoot, targetPath: targetRoot, targetSource: "default" },
    );
    expect(outcome.status).toBe("migrated");
    expect(outcome.streams_moved).toBe(2);
    expect(outcome.bytes_moved).toBe(0);
    // Source still there, untouched.
    expect((await readdir(join(legacyRoot, "jetstream", "$G", "streams"))).sort()).toEqual([
      "DR1",
      "DR2",
    ]);
    // Target was never created.
    expect(await dirExists(targetRoot)).toBe(false);
    // Resolved-paths log emitted exactly once with dry_run: true.
    expect(infoCalls).toHaveLength(1);
    expect(infoCalls[0]?.context.dry_run).toBe(true);
  });

  it("emits resolved-paths log line exactly once per call", async () => {
    await seedStore(legacyRoot, ["A"]);
    const { logger, infoCalls } = createCapturingLogger();
    await runRelocate(
      { logger, dryRun: false },
      { legacyPath: legacyRoot, targetPath: targetRoot, targetSource: "env" },
    );
    expect(infoCalls).toHaveLength(1);
    const ctx = infoCalls[0]?.context;
    expect(ctx).toMatchObject({
      id: "relocate-jetstream-store",
      legacy_path: legacyRoot,
      target_path: targetRoot,
      target_source: "env",
      dry_run: false,
    });
  });
});
