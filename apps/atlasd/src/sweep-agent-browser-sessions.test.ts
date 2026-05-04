import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sweepOrphanedAgentBrowserSessions } from "./sweep-agent-browser-sessions.ts";

const NOOP_LOGGER = { info: vi.fn(), warn: vi.fn() };

const VALID_UUID = "11111111-2222-3333-4444-555555555555";
const VALID_UUID_2 = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

async function writeSessionFiles(dir: string, session: string, pid: number) {
  for (const ext of ["pid", "sock", "engine", "stream", "version"]) {
    await writeFile(join(dir, `${session}.${ext}`), ext === "pid" ? String(pid) : "x");
  }
}

describe("sweepOrphanedAgentBrowserSessions", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atlas-sweep-"));
    NOOP_LOGGER.info.mockReset();
    NOOP_LOGGER.warn.mockReset();
  });

  afterEach(async () => {
    // mkdtemp cleanup is best-effort — tests don't rely on it
  });

  it("returns empty result when directory does not exist", async () => {
    const missing = join(dir, "does-not-exist");
    const result = await sweepOrphanedAgentBrowserSessions(NOOP_LOGGER, { dir: missing });
    expect(result).toEqual({ scanned: 0, closed: 0, killed: 0, staleFilesOnly: 0, errors: [] });
  });

  it("ignores non-Friday session names", async () => {
    // User-launched flat-name sessions must not be touched
    for (const ext of ["pid", "sock"]) {
      await writeFile(join(dir, `amazon.${ext}`), "1234");
      await writeFile(join(dir, `default.${ext}`), "1234");
      await writeFile(join(dir, `bh2.${ext}`), "1234");
    }
    // Also ignore atlas-web-* without proper UUID shape
    await writeFile(join(dir, "atlas-web-not-a-uuid.pid"), "1234");

    const result = await sweepOrphanedAgentBrowserSessions(NOOP_LOGGER, {
      dir,
      isPidAlive: () => true,
      closeSession: vi.fn(),
      killByPid: vi.fn(),
    });

    expect(result.scanned).toBe(0);
    // Files still there
    const remaining = await readdir(dir);
    expect(remaining).toContain("amazon.pid");
    expect(remaining).toContain("default.sock");
    expect(remaining).toContain("atlas-web-not-a-uuid.pid");
  });

  it("removes stale files for dead PIDs without calling close/kill", async () => {
    await writeSessionFiles(dir, `atlas-web-${VALID_UUID}`, 99999);
    const closeSession = vi.fn();
    const killByPid = vi.fn();

    const result = await sweepOrphanedAgentBrowserSessions(NOOP_LOGGER, {
      dir,
      isPidAlive: () => false,
      closeSession,
      killByPid,
    });

    expect(result).toMatchObject({ scanned: 1, closed: 0, killed: 0, staleFilesOnly: 1 });
    expect(closeSession).not.toHaveBeenCalled();
    expect(killByPid).not.toHaveBeenCalled();

    const remaining = await readdir(dir);
    expect(remaining.filter((e) => e.startsWith("atlas-web-"))).toEqual([]);
  });

  it("calls close for live daemons and removes files", async () => {
    await writeSessionFiles(dir, `atlas-web-${VALID_UUID}`, 12345);
    const closeSession = vi.fn().mockResolvedValue(undefined);
    const killByPid = vi.fn();

    const result = await sweepOrphanedAgentBrowserSessions(NOOP_LOGGER, {
      dir,
      isPidAlive: (pid) => pid === 12345,
      closeSession,
      killByPid,
    });

    expect(result).toMatchObject({ scanned: 1, closed: 1, killed: 0, staleFilesOnly: 0 });
    expect(closeSession).toHaveBeenCalledWith(`atlas-web-${VALID_UUID}`);
    expect(killByPid).not.toHaveBeenCalled();

    const remaining = await readdir(dir);
    expect(remaining).toEqual([]);
  });

  it("falls back to killByPid when close fails", async () => {
    await writeSessionFiles(dir, `atlas-web-${VALID_UUID}`, 12345);
    const closeSession = vi.fn().mockRejectedValue(new Error("ENOENT"));
    const killByPid = vi.fn().mockResolvedValue(true);

    const result = await sweepOrphanedAgentBrowserSessions(NOOP_LOGGER, {
      dir,
      isPidAlive: (pid) => pid === 12345,
      closeSession,
      killByPid,
    });

    expect(result).toMatchObject({ scanned: 1, closed: 0, killed: 1, staleFilesOnly: 0 });
    expect(killByPid).toHaveBeenCalledWith(12345);
  });

  it("records error when neither close nor kill succeeds", async () => {
    await writeSessionFiles(dir, `atlas-web-${VALID_UUID}`, 12345);
    const closeSession = vi.fn().mockRejectedValue(new Error("close failed"));
    const killByPid = vi.fn().mockResolvedValue(false);

    const result = await sweepOrphanedAgentBrowserSessions(NOOP_LOGGER, {
      dir,
      isPidAlive: () => true,
      closeSession,
      killByPid,
    });

    expect(result.scanned).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.session).toBe(`atlas-web-${VALID_UUID}`);
  });

  it("processes multiple sessions independently", async () => {
    await writeSessionFiles(dir, `atlas-web-${VALID_UUID}`, 12345); // alive
    await writeSessionFiles(dir, `atlas-web-${VALID_UUID_2}`, 99999); // dead
    await writeFile(join(dir, "amazon.pid"), "777"); // user, ignore

    const closeSession = vi.fn().mockResolvedValue(undefined);
    const result = await sweepOrphanedAgentBrowserSessions(NOOP_LOGGER, {
      dir,
      isPidAlive: (pid) => pid === 12345,
      closeSession,
      killByPid: vi.fn(),
    });

    expect(result).toMatchObject({ scanned: 2, closed: 1, staleFilesOnly: 1 });
    expect(closeSession).toHaveBeenCalledTimes(1);
    expect(closeSession).toHaveBeenCalledWith(`atlas-web-${VALID_UUID}`);

    const remaining = await readdir(dir);
    expect(remaining).toEqual(["amazon.pid"]);
  });

  it("handles missing or unreadable pid file as 'not alive'", async () => {
    // Create only sock + version, no pid file
    await writeFile(join(dir, `atlas-web-${VALID_UUID}.sock`), "x");
    await writeFile(join(dir, `atlas-web-${VALID_UUID}.version`), "x");
    // But the regex matches only on .pid presence, so this entry is ignored.
    const result = await sweepOrphanedAgentBrowserSessions(NOOP_LOGGER, {
      dir,
      isPidAlive: () => true,
      closeSession: vi.fn(),
      killByPid: vi.fn(),
    });
    expect(result.scanned).toBe(0);
    // Now add a pid file with garbage contents
    await writeFile(join(dir, `atlas-web-${VALID_UUID}.pid`), "not-a-number");
    const result2 = await sweepOrphanedAgentBrowserSessions(NOOP_LOGGER, {
      dir,
      isPidAlive: () => true, // would be true if asked
      closeSession: vi.fn(),
      killByPid: vi.fn(),
    });
    expect(result2.scanned).toBe(1);
    expect(result2.staleFilesOnly).toBe(1); // unreadable pid → treated as not alive
  });

  it("does not log when nothing was scanned", async () => {
    await mkdir(dir, { recursive: true });
    await sweepOrphanedAgentBrowserSessions(NOOP_LOGGER, { dir });
    expect(NOOP_LOGGER.info).not.toHaveBeenCalled();
  });
});
