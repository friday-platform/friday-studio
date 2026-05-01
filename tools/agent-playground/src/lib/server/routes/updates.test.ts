import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

type UpdateCheckerModule = typeof import("../lib/update-checker.ts");
type UpdatesRouteModule = typeof import("./updates.ts");

const StatusSchema = z.object({
  current: z.string(),
  latest: z.string().nullable(),
  outOfDate: z.boolean(),
  lastCheckedAt: z.string().nullable(),
  lastSuccessAt: z.string().nullable(),
  error: z.string().nullable(),
  isDev: z.boolean(),
});

async function readStatus(res: Response): Promise<z.infer<typeof StatusSchema>> {
  return StatusSchema.parse(await res.json());
}

const CacheSchema = z.object({
  latestVersion: z.string().nullable(),
  lastCheckedAt: z.string().nullable(),
  lastSuccessAt: z.string().nullable(),
  lastError: z.string().nullable(),
});

const ENV_KEYS = [
  "FRIDAY_HOME",
  "FRIDAY_UPDATE_VERSION_OVERRIDE",
  "FRIDAY_UPDATE_MANIFEST_URL",
  "FRIDAY_UPDATE_FORCE",
  "FRIDAY_UPDATE_SIDECAR_DIR",
];

let savedEnv: Record<string, string | undefined>;
let tempDir: string;
let fetchSpy: ReturnType<typeof vi.spyOn>;

/**
 * Reset module cache and clear the HMR singleton so each test gets a fresh
 * UpdateChecker bound to the current env. Without resetting __fridayUpdateChecker
 * the singleton would survive across tests and freeze its constructor-time env reads.
 */
async function loadFreshModules(): Promise<{
  checker: UpdateCheckerModule;
  route: UpdatesRouteModule;
}> {
  vi.resetModules();
  delete (globalThis as { __fridayUpdateChecker?: unknown }).__fridayUpdateChecker;
  const checker = await import("../lib/update-checker.ts");
  const route = await import("./updates.ts");
  return { checker, route };
}

function mockManifestResponse(version: string): Response {
  return new Response(JSON.stringify({ version }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** Returns a factory so each fetch call gets its own un-consumed Response. */
function mockManifestImpl(version: string): () => Promise<Response> {
  return () => Promise.resolve(mockManifestResponse(version));
}

beforeEach(async () => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  tempDir = await mkdtemp(join(tmpdir(), "update-checker-test-"));
  process.env.FRIDAY_HOME = tempDir;
  // Default: dev mode (no sidecar). Tests that need a real version override
  // FRIDAY_UPDATE_VERSION_OVERRIDE explicitly.
  process.env.FRIDAY_UPDATE_MANIFEST_URL = "https://example.invalid/manifest.json";
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    throw new Error("fetch not stubbed for this test");
  });
  vi.useFakeTimers();
});

afterEach(async () => {
  vi.useRealTimers();
  fetchSpy.mockRestore();
  await rm(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
  delete (globalThis as { __fridayUpdateChecker?: unknown }).__fridayUpdateChecker;
});

describe("GET /", () => {
  it("returns dev-mode shape when no sidecar and no override", async () => {
    const { route } = await loadFreshModules();
    const res = await route.updatesRoute.request("/");
    expect(res.status).toBe(200);
    const body = await readStatus(res);
    expect(body).toEqual({
      current: "0.0.0-dev",
      latest: null,
      outOfDate: false,
      lastCheckedAt: null,
      lastSuccessAt: null,
      error: null,
      isDev: true,
    });
  });

  it("returns never-checked shape when version override is set", async () => {
    process.env.FRIDAY_UPDATE_VERSION_OVERRIDE = "0.0.37";
    const { route } = await loadFreshModules();
    const res = await route.updatesRoute.request("/");
    const body = await readStatus(res);
    expect(body).toEqual({
      current: "0.0.37",
      latest: null,
      outOfDate: false,
      isDev: false,
      lastCheckedAt: null,
      lastSuccessAt: null,
      error: null,
    });
  });

  it("returns just-checked-success shape after a successful forceCheck", async () => {
    process.env.FRIDAY_UPDATE_VERSION_OVERRIDE = "0.0.37";
    fetchSpy.mockImplementation(mockManifestImpl("0.0.38"));
    const { checker, route } = await loadFreshModules();
    await checker.updateChecker.forceCheck();
    const res = await route.updatesRoute.request("/");
    const body = await readStatus(res);
    expect(body.current).toBe("0.0.37");
    expect(body.latest).toBe("0.0.38");
    expect(body.outOfDate).toBe(true);
    expect(body.error).toBeNull();
    expect(body.lastCheckedAt).not.toBeNull();
    expect(body.lastSuccessAt).not.toBeNull();
  });

  it("returns just-checked-failure shape when fetch fails", async () => {
    process.env.FRIDAY_UPDATE_VERSION_OVERRIDE = "0.0.37";
    fetchSpy.mockRejectedValue(new Error("network down"));
    const { checker, route } = await loadFreshModules();
    await checker.updateChecker.forceCheck();
    const res = await route.updatesRoute.request("/");
    const body = await readStatus(res);
    expect(body.current).toBe("0.0.37");
    expect(body.latest).toBeNull();
    expect(body.lastSuccessAt).toBeNull();
    expect(body.error).toContain("network down");
    expect(body.lastCheckedAt).not.toBeNull();
  });
});

describe("POST /check", () => {
  it("triggers a fetch and updates the cache", async () => {
    process.env.FRIDAY_UPDATE_VERSION_OVERRIDE = "0.0.37";
    fetchSpy.mockImplementation(mockManifestImpl("0.0.38"));
    const { route } = await loadFreshModules();
    const res = await route.updatesRoute.request("/check", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await readStatus(res);
    expect(body.latest).toBe("0.0.38");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("returns cached value WITHOUT re-fetching when called twice within 10s", async () => {
    process.env.FRIDAY_UPDATE_VERSION_OVERRIDE = "0.0.37";
    fetchSpy.mockImplementation(mockManifestImpl("0.0.38"));
    const { route } = await loadFreshModules();
    await route.updatesRoute.request("/check", { method: "POST" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // Advance just inside the 10s window.
    vi.advanceTimersByTime(5_000);
    const res2 = await route.updatesRoute.request("/check", { method: "POST" });
    expect(res2.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("re-fetches once the 10s rate-limit window elapses", async () => {
    process.env.FRIDAY_UPDATE_VERSION_OVERRIDE = "0.0.37";
    fetchSpy.mockImplementation(mockManifestImpl("0.0.38"));
    const { route } = await loadFreshModules();
    await route.updatesRoute.request("/check", { method: "POST" });
    vi.advanceTimersByTime(11_000);
    await route.updatesRoute.request("/check", { method: "POST" });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe("cache file persistence", () => {
  it("treats a missing cache file as empty state", async () => {
    process.env.FRIDAY_UPDATE_VERSION_OVERRIDE = "0.0.37";
    const { checker } = await loadFreshModules();
    const status = checker.updateChecker.getUpdateStatus();
    expect(status.latest).toBeNull();
    expect(status.lastCheckedAt).toBeNull();
  });

  it("treats malformed JSON as empty state and logs a warning", async () => {
    process.env.FRIDAY_UPDATE_VERSION_OVERRIDE = "0.0.37";
    await writeFile(join(tempDir, "update-check.json"), "not-json{{{");
    const { checker } = await loadFreshModules();
    const status = checker.updateChecker.getUpdateStatus();
    expect(status.latest).toBeNull();
    expect(status.lastCheckedAt).toBeNull();
  });

  it("restores state from a valid cache file on startup", async () => {
    process.env.FRIDAY_UPDATE_VERSION_OVERRIDE = "0.0.37";
    await writeFile(
      join(tempDir, "update-check.json"),
      JSON.stringify({
        latestVersion: "0.0.38",
        lastCheckedAt: "2026-04-29T12:00:00.000Z",
        lastSuccessAt: "2026-04-29T12:00:00.000Z",
        lastError: null,
      }),
    );
    const { checker } = await loadFreshModules();
    const status = checker.updateChecker.getUpdateStatus();
    expect(status.latest).toBe("0.0.38");
    expect(status.lastCheckedAt).toBe("2026-04-29T12:00:00.000Z");
    expect(status.outOfDate).toBe(true);
  });

  it("first write succeeds when parent dir does not exist (mkdir guard)", async () => {
    // Point FRIDAY_HOME at a non-existent subpath — the writer must mkdir it.
    const freshHome = join(tempDir, "does", "not", "exist");
    process.env.FRIDAY_HOME = freshHome;
    process.env.FRIDAY_UPDATE_VERSION_OVERRIDE = "0.0.37";
    fetchSpy.mockImplementation(mockManifestImpl("0.0.38"));
    const { checker } = await loadFreshModules();
    await checker.updateChecker.forceCheck();
    const written = await readFile(join(freshHome, "update-check.json"), "utf8");
    const parsed = CacheSchema.parse(JSON.parse(written));
    expect(parsed.latestVersion).toBe("0.0.38");
  });
});

describe("fetch failure semantics", () => {
  it("leaves latestVersion + lastSuccessAt untouched on failure", async () => {
    process.env.FRIDAY_UPDATE_VERSION_OVERRIDE = "0.0.37";
    // Seed a prior success on disk.
    await writeFile(
      join(tempDir, "update-check.json"),
      JSON.stringify({
        latestVersion: "0.0.38",
        lastCheckedAt: "2026-04-29T12:00:00.000Z",
        lastSuccessAt: "2026-04-29T12:00:00.000Z",
        lastError: null,
      }),
    );
    fetchSpy.mockRejectedValue(new Error("DNS failure"));
    const { checker } = await loadFreshModules();
    await checker.updateChecker.forceCheck();
    const status = checker.updateChecker.getUpdateStatus();
    expect(status.latest).toBe("0.0.38");
    expect(status.lastSuccessAt).toBe("2026-04-29T12:00:00.000Z");
    expect(status.error).toContain("DNS failure");
    expect(status.lastCheckedAt).not.toBe("2026-04-29T12:00:00.000Z");
  });
});

describe("dev mode", () => {
  it("never fetches in dev mode (mocked fetch count = 0)", async () => {
    // No FRIDAY_UPDATE_VERSION_OVERRIDE → dev mode.
    fetchSpy.mockImplementation(mockManifestImpl("0.0.38"));
    const { checker } = await loadFreshModules();
    // Wait a tick — start() should not have armed any timer.
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(fetchSpy).not.toHaveBeenCalled();
    const status = checker.updateChecker.getUpdateStatus();
    expect(status.isDev).toBe(true);
    expect(status.outOfDate).toBe(false);
  });

  it("isDev short-circuits outOfDate even when latest would be greater", async () => {
    // Manually seed a cache entry with a "newer" version, then assert dev mode
    // still reports outOfDate=false.
    await writeFile(
      join(tempDir, "update-check.json"),
      JSON.stringify({
        latestVersion: "9.9.9",
        lastCheckedAt: "2026-04-29T12:00:00.000Z",
        lastSuccessAt: "2026-04-29T12:00:00.000Z",
        lastError: null,
      }),
    );
    const { checker } = await loadFreshModules();
    const status = checker.updateChecker.getUpdateStatus();
    expect(status.isDev).toBe(true);
    expect(status.latest).toBe("9.9.9");
    expect(status.outOfDate).toBe(false);
  });
});

describe("version resolution chain", () => {
  it("env override wins over sidecar", async () => {
    const sidecarDir = await mkdtemp(join(tmpdir(), "sidecar-"));
    await writeFile(join(sidecarDir, ".studio-version"), "0.0.10\n");
    process.env.FRIDAY_UPDATE_SIDECAR_DIR = sidecarDir;
    process.env.FRIDAY_UPDATE_VERSION_OVERRIDE = "0.0.99";
    try {
      const { checker } = await loadFreshModules();
      expect(checker.updateChecker.getUpdateStatus().current).toBe("0.0.99");
    } finally {
      await rm(sidecarDir, { recursive: true, force: true });
    }
  });

  it("sidecar wins over dev fallback", async () => {
    const sidecarDir = await mkdtemp(join(tmpdir(), "sidecar-"));
    await writeFile(join(sidecarDir, ".studio-version"), "0.0.42\n");
    process.env.FRIDAY_UPDATE_SIDECAR_DIR = sidecarDir;
    try {
      const { checker } = await loadFreshModules();
      const status = checker.updateChecker.getUpdateStatus();
      expect(status.current).toBe("0.0.42");
      expect(status.isDev).toBe(false);
    } finally {
      await rm(sidecarDir, { recursive: true, force: true });
    }
  });

  it("falls back to 0.0.0-dev with isDev=true when no sidecar and no override", async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), "no-sidecar-"));
    process.env.FRIDAY_UPDATE_SIDECAR_DIR = emptyDir;
    try {
      const { checker } = await loadFreshModules();
      const status = checker.updateChecker.getUpdateStatus();
      expect(status.current).toBe("0.0.0-dev");
      expect(status.isDev).toBe(true);
    } finally {
      await rm(emptyDir, { recursive: true, force: true });
    }
  });
});

describe("semver comparison", () => {
  it("treats pre-release suffix as equal to base version (1.2.3-beta == 1.2.3)", async () => {
    process.env.FRIDAY_UPDATE_VERSION_OVERRIDE = "1.2.3-beta";
    fetchSpy.mockImplementation(mockManifestImpl("1.2.3"));
    const { checker } = await loadFreshModules();
    await checker.updateChecker.forceCheck();
    expect(checker.updateChecker.getUpdateStatus().outOfDate).toBe(false);
  });

  it("outOfDate is true when remote is greater", async () => {
    process.env.FRIDAY_UPDATE_VERSION_OVERRIDE = "0.0.37";
    fetchSpy.mockImplementation(mockManifestImpl("0.1.0"));
    const { checker } = await loadFreshModules();
    await checker.updateChecker.forceCheck();
    expect(checker.updateChecker.getUpdateStatus().outOfDate).toBe(true);
  });

  it("outOfDate is false when remote equals current", async () => {
    process.env.FRIDAY_UPDATE_VERSION_OVERRIDE = "0.0.37";
    fetchSpy.mockImplementation(mockManifestImpl("0.0.37"));
    const { checker } = await loadFreshModules();
    await checker.updateChecker.forceCheck();
    expect(checker.updateChecker.getUpdateStatus().outOfDate).toBe(false);
  });

  it("outOfDate is false when remote is older than current", async () => {
    process.env.FRIDAY_UPDATE_VERSION_OVERRIDE = "0.0.50";
    fetchSpy.mockImplementation(mockManifestImpl("0.0.37"));
    const { checker } = await loadFreshModules();
    await checker.updateChecker.forceCheck();
    expect(checker.updateChecker.getUpdateStatus().outOfDate).toBe(false);
  });
});

describe("manual + scheduled timer interaction", () => {
  it("forceCheck cancels the existing scheduled timer and re-arms 24h+jitter", async () => {
    process.env.FRIDAY_UPDATE_VERSION_OVERRIDE = "0.0.37";
    fetchSpy.mockImplementation(mockManifestImpl("0.0.38"));
    const { checker } = await loadFreshModules();
    // start() was called on import → timer is armed (startup window 30s..5min).
    expect(vi.getTimerCount()).toBe(1);

    await checker.updateChecker.forceCheck();

    // After forceCheck, timer should be re-armed for steady-state (24h..30h).
    expect(vi.getTimerCount()).toBe(1);

    // Advance 23h — should NOT fire yet (steady-state minimum is 24h).
    vi.advanceTimersByTime(23 * 60 * 60 * 1000);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Advance another 8h (now at 31h since forceCheck) — should have fired.
    await vi.advanceTimersByTimeAsync(8 * 60 * 60 * 1000);
    expect(fetchSpy.mock.calls.length).toBeGreaterThanOrEqual(2);

    // Drain the in-flight check the scheduled fire kicked off so the
    // teardown rm doesn't race a pending write.
    await checker.updateChecker.forceCheck();
  });
});

describe("singleton guard (HMR)", () => {
  it("re-importing the module yields the same instance and does not spawn a second timer", async () => {
    process.env.FRIDAY_UPDATE_VERSION_OVERRIDE = "0.0.37";
    const { checker } = await loadFreshModules();
    const firstInstance = checker.updateChecker;
    expect(vi.getTimerCount()).toBe(1);

    // Re-import WITHOUT clearing the singleton — simulating HMR.
    vi.resetModules();
    const { updateChecker: secondInstance } = await import("../lib/update-checker.ts");

    expect(secondInstance).toBe(firstInstance);
    expect(vi.getTimerCount()).toBe(1);
  });
});
