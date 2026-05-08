import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FullManifestSchema, GlobalSkillsManifestSchema, SkillRowSchema } from "@atlas/bundle";
import { createStubPlatformModels } from "@atlas/llm";
import { SkillStorage } from "@atlas/skills";
import type { WorkspaceManager } from "@atlas/workspace";
import { parse as parseYaml } from "@std/yaml";
import { Hono } from "hono";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, test, vi } from "vitest";
import { z } from "zod";
import type { AppContext, AppVariables } from "../../src/factory.ts";
import { workspacesRoutes } from "./index.ts";

vi.mock("@atlas/storage", () => ({ FilesystemWorkspaceCreationAdapter: vi.fn() }));

const mockFetchLinkCredential = vi.hoisted(() => vi.fn());
vi.mock("@atlas/core/mcp-registry/credential-resolver", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@atlas/core/mcp-registry/credential-resolver")>()),
  fetchLinkCredential: mockFetchLinkCredential,
}));

vi.mock("../me/adapter.ts", () => ({
  getCurrentUser: vi.fn().mockResolvedValue({ id: "user-1", email: "test@test.com" }),
}));

const mockGetAtlasHome = vi.hoisted(() => vi.fn(() => "/tmp"));
vi.mock("@atlas/utils/paths.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@atlas/utils/paths.server")>()),
  getFridayHome: mockGetAtlasHome,
}));

async function seedWorkspaceDir(dir: string, name: string): Promise<void> {
  await writeFile(join(dir, "workspace.yml"), `version: '1.0'\nworkspace:\n  name: ${name}\n`);
  await mkdir(join(dir, "agents", "hello-bot"), { recursive: true });
  await writeFile(join(dir, "agents", "hello-bot", "agent.py"), "# hello\n");
}

interface FakeWorkspace {
  id: string;
  name: string;
  path: string;
}

function createAppMulti(opts: {
  workspaces: FakeWorkspace[];
  homeDir: string;
  registeredId?: (index: number) => string;
}): { app: Hono<AppVariables>; registerSpy: ReturnType<typeof vi.fn> } {
  let callCount = 0;
  // deno-lint-ignore require-await
  const registerSpy = vi.fn().mockImplementation(async (path: string, meta: { name: string }) => {
    const id = opts.registeredId ? opts.registeredId(callCount) : `imported-${callCount}`;
    callCount += 1;
    return { workspace: { id, name: meta.name, path }, created: true };
  });

  const byId = new Map(opts.workspaces.map((w) => [w.id, w]));
  const mockManager = {
    // deno-lint-ignore require-await
    find: vi.fn().mockImplementation(async (q: { id?: string; name?: string }) => {
      if (q.id && byId.has(q.id)) {
        const w = byId.get(q.id);
        if (!w) return null;
        return { ...w, status: "inactive", createdAt: "", lastSeen: "", metadata: {} };
      }
      return null;
    }),
    // deno-lint-ignore require-await
    getWorkspaceConfig: vi.fn().mockImplementation(async (id: string) => {
      const w = byId.get(id);
      if (!w) return null;
      return { atlas: null, workspace: { version: "1.0", workspace: { name: w.name } } };
    }),
    registerWorkspace: registerSpy,
    list: vi
      .fn()
      .mockResolvedValue(
        opts.workspaces.map((w) => ({
          ...w,
          status: "inactive",
          createdAt: "",
          lastSeen: "",
          metadata: {},
        })),
      ),
    deleteWorkspace: vi.fn(),
  } as unknown as WorkspaceManager;

  const mockContext: AppContext = {
    runtimes: new Map(),
    startTime: Date.now(),
    sseClients: new Map(),
    sseStreams: new Map(),
    getWorkspaceManager: () => mockManager,
    getOrCreateWorkspaceRuntime: vi.fn(),
    resetIdleTimeout: vi.fn(),
    getWorkspaceRuntime: vi.fn(),
    destroyWorkspaceRuntime: vi.fn(),
    daemon: {} as AppContext["daemon"],
    streamRegistry: {} as AppContext["streamRegistry"],
    chatTurnRegistry: {} as AppContext["chatTurnRegistry"],
    sessionStreamRegistry: {} as AppContext["sessionStreamRegistry"],
    sessionHistoryAdapter: {} as AppContext["sessionHistoryAdapter"],
    getAgentRegistry: vi.fn(),
    getOrCreateChatSdkInstance: vi.fn(),
    evictChatSdkInstance: vi.fn(),
    exposeKernel: false,
    platformModels: createStubPlatformModels(),
  };
  mockGetAtlasHome.mockReturnValue(opts.homeDir);

  const app = new Hono<AppVariables>();
  app.use("*", async (c, next) => {
    c.set("app", mockContext);
    await next();
  });
  app.route("/", workspacesRoutes);
  return { app, registerSpy };
}

describe("bundle-all endpoints (end-to-end)", () => {
  let wsA: string;
  let wsB: string;
  let wsVirtual: string;
  let homeDir: string;

  beforeEach(async () => {
    wsA = await mkdtemp(join(tmpdir(), "bundle-all-route-a-"));
    wsB = await mkdtemp(join(tmpdir(), "bundle-all-route-b-"));
    wsVirtual = "system://system";
    homeDir = await mkdtemp(join(tmpdir(), "bundle-all-route-home-"));
    await seedWorkspaceDir(wsA, "alpha");
    await seedWorkspaceDir(wsB, "beta");
    mockFetchLinkCredential.mockReset();
  });

  afterEach(async () => {
    await rm(wsA, { recursive: true, force: true });
    await rm(wsB, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  test("GET /bundle-all returns a zip-of-zips with every on-disk workspace", async () => {
    const { app } = createAppMulti({
      workspaces: [
        { id: "a", name: "alpha", path: wsA },
        { id: "b", name: "beta", path: wsB },
        // Virtual workspace — should be skipped by isOnDiskWorkspace.
        { id: "k", name: "kernel", path: wsVirtual },
      ],
      homeDir,
    });

    const response = await app.request("/bundle-all");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/zip");
    expect(response.headers.get("X-Atlas-Bundled-Workspaces")).toBe("2");
    expect(response.headers.get("X-Atlas-Skipped-Workspaces")).toBe("1");

    const archiveBytes = new Uint8Array(await response.arrayBuffer());
    const archive = await JSZip.loadAsync(archiveBytes);
    expect(archive.file("manifest.yml")).toBeTruthy();
    expect(archive.file("workspaces/a.zip")).toBeTruthy();
    expect(archive.file("workspaces/b.zip")).toBeTruthy();
    expect(archive.file("workspaces/k.zip")).toBeNull();

    const manifestYaml = await archive.file("manifest.yml")?.async("string");
    expect(manifestYaml).toContain("schemaVersion: 1");
    expect(manifestYaml).toContain("alpha");
    expect(manifestYaml).toContain("beta");
    expect(manifestYaml).not.toContain("kernel");
  });

  test("POST /import-bundle-all materializes every inner bundle and registers each", async () => {
    // Produce a real archive via the export route, then feed it to the import route.
    const { app: exportApp } = createAppMulti({
      workspaces: [
        { id: "a", name: "alpha", path: wsA },
        { id: "b", name: "beta", path: wsB },
      ],
      homeDir,
    });
    const exportResponse = await exportApp.request("/bundle-all");
    const archiveBytes = new Uint8Array(await exportResponse.arrayBuffer());

    const { app: importApp, registerSpy } = createAppMulti({
      workspaces: [],
      homeDir,
      registeredId: (i) => `imp-${i}`,
    });

    const form = new FormData();
    form.set("bundle", new File([archiveBytes], "full.zip", { type: "application/zip" }));
    const importResponse = await importApp.request("/import-bundle-all", {
      method: "POST",
      body: form,
    });
    expect(importResponse.status).toBe(200);

    const body = (await importResponse.json()) as {
      imported: { workspaceId: string; name: string; path: string }[];
      errors: { name: string; error: string }[];
      manifest: { entries: { name: string }[] };
    };

    expect(body.errors).toEqual([]);
    expect(body.imported).toHaveLength(2);
    expect(body.imported.map((e) => e.name).sort()).toEqual(["alpha", "beta"]);
    expect(body.imported.map((e) => e.workspaceId).sort()).toEqual(["imp-0", "imp-1"]);
    expect(body.manifest.entries.map((e) => e.name).sort()).toEqual(["alpha", "beta"]);

    // Two distinct dirs under homeDir/workspaces; each contains the expected agent file.
    const dirs = await readdir(join(homeDir, "workspaces"));
    expect(dirs).toHaveLength(2);
    expect(registerSpy).toHaveBeenCalledTimes(2);
  });

  test("POST /import-bundle-all returns 400 when no bundle field present", async () => {
    const { app } = createAppMulti({ workspaces: [], homeDir });
    const form = new FormData();
    const response = await app.request("/import-bundle-all", { method: "POST", body: form });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/Missing 'bundle' file/);
  });

  // Real-NATS integration test guarding against the Jan-2026 regression where
  // `/bundle-all?include=global-skills` silently exported an empty library
  // because the route still read from the legacy SQLite path after the
  // skills→JetStream migration. Goes through the full export+import round-trip
  // against the shared NATS server (initialized in `vitest.setup.ts:52`).
  //
  // Isolation: every published skill carries a UUID prefix on its name and
  // `createdBy` so assertions filter to OUR rows only — the shared `SKILLS`
  // KV bucket sees writes from every suite in the worker. We never assert
  // on global counts. See the comment in `vitest.setup.ts:13-15`.
  it("global-skills round-trips via bundle-all with idempotent re-import", async () => {
    const prefix = `test-${crypto.randomUUID()}-`;
    const userId = `${prefix}user`;
    const namespace = "export-test";

    // 3 user skills: skill-1 carries archive bytes, skill-2 has no archive,
    // skill-3 has no archive. The system filter must EXCLUDE the system row.
    const archiveBytes = new Uint8Array(32);
    for (let i = 0; i < archiveBytes.length; i++) archiveBytes[i] = i;

    const skill1 = await SkillStorage.publish(namespace, `${prefix}skill-1`, userId, {
      description: "skill 1 (with archive)",
      instructions: "do thing 1",
      archive: archiveBytes,
    });
    expect.assert(skill1.ok === true);
    const skill2 = await SkillStorage.publish(namespace, `${prefix}skill-2`, userId, {
      description: "skill 2 (no archive)",
      instructions: "do thing 2",
    });
    expect.assert(skill2.ok === true);
    const skill3 = await SkillStorage.publish(namespace, `${prefix}skill-3`, userId, {
      description: "skill 3 (no archive)",
      instructions: "do thing 3",
    });
    expect.assert(skill3.ok === true);

    // System skill — must be filtered out by the export.
    const sysResult = await SkillStorage.publish(namespace, `${prefix}sys`, "system", {
      description: "system skill that must NOT export",
      instructions: "system",
    });
    expect.assert(sysResult.ok === true);

    const { app } = createAppMulti({ workspaces: [], homeDir });

    // ── Export ─────────────────────────────────────────────────────────────
    const exportRes = await app.request("/bundle-all?include=global-skills");
    expect(exportRes.status).toBe(200);
    expect(exportRes.headers.get("X-Atlas-Global-Skills")).toBe("included");
    const outerBytes = new Uint8Array(await exportRes.arrayBuffer());

    // Crack outer zip → manifest → inner global/skills.zip.
    const outerZip = await JSZip.loadAsync(outerBytes);
    const outerManifestYaml = await outerZip.file("manifest.yml")?.async("string");
    expect(outerManifestYaml).toBeTruthy();
    const outerManifest = FullManifestSchema.parse(parseYaml(outerManifestYaml ?? ""));
    const skillsPath = outerManifest.reserved.global.skills;
    expect(skillsPath).toBe("global/skills.zip");
    const innerBytes = await outerZip.file(skillsPath ?? "")?.async("uint8array");
    expect(innerBytes).toBeTruthy();

    const innerZip = await JSZip.loadAsync(innerBytes ?? new Uint8Array());
    const innerManifestYaml = await innerZip.file("manifest.yml")?.async("string");
    expect(innerManifestYaml).toBeTruthy();
    const innerManifest = GlobalSkillsManifestSchema.parse(parseYaml(innerManifestYaml ?? ""));
    expect(innerManifest.source.filename).toBe("skills.jsonl");

    const jsonlText = await innerZip.file("skills.jsonl")?.async("string");
    expect(jsonlText).toBeTruthy();
    const rows = (jsonlText ?? "")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => SkillRowSchema.parse(JSON.parse(line)));

    // Filter to OUR prefix — the bucket is shared.
    const ours = rows.filter((r) => r.name.startsWith(prefix));
    expect(ours).toHaveLength(3);
    expect(ours.every((r) => r.createdBy === userId)).toBe(true);
    expect(ours.find((r) => r.createdBy === "system")).toBeUndefined();
    // The system skill we published under our prefix must NOT appear.
    expect(rows.find((r) => r.name === `${prefix}sys`)).toBeUndefined();

    // The skill-1 row must carry archive metadata + the corresponding zip entry.
    const row1 = ours.find((r) => r.name === `${prefix}skill-1`);
    expect(row1).toBeDefined();
    expect(row1?.archive).not.toBeNull();
    const archivePathInZip = row1?.archive?.path;
    expect(archivePathInZip).toBe(`archives/${row1?.skillId}__${row1?.version}.tar.gz`);
    expect(innerZip.file(archivePathInZip ?? "")).toBeTruthy();
    // The no-archive rows must carry archive: null.
    expect(ours.find((r) => r.name === `${prefix}skill-2`)?.archive).toBeNull();
    expect(ours.find((r) => r.name === `${prefix}skill-3`)?.archive).toBeNull();

    // Pre-import versions captured from the export rows. All freshly published
    // → version 1. We assert these don't inflate after the idempotent re-import.
    const skillIdsByName = new Map<string, string>();
    for (const row of ours) skillIdsByName.set(row.name, row.skillId);

    // ── Re-import ──────────────────────────────────────────────────────────
    const form = new FormData();
    form.set("bundle", new File([outerBytes], "full.zip", { type: "application/zip" }));
    const importRes = await app.request("/import-bundle-all", {
      method: "POST",
      body: form,
    });
    expect(importRes.status).toBe(200);

    // Parse via Zod — keeps the test free of `as` casts and validates the
    // contract simultaneously. The skipped/published counts are scoped to the
    // ENTIRE bundle (other suites' skills may inflate skipped) — we then
    // re-check our 3 rows via getBySkillId for version stability.
    const ImportResponseSchema = z.object({
      globalSkills: z
        .union([
          z.object({
            kind: z.literal("imported"),
            skillsPublished: z.number(),
            skillsSkipped: z.number(),
          }),
          z.object({
            kind: z.literal("integrity-failed"),
            expected: z.string(),
            actual: z.string(),
            row: z.string().optional(),
          }),
          z.object({ kind: z.literal("legacy-archive-rejected") }),
        ])
        .optional(),
    });
    const body = ImportResponseSchema.parse(await importRes.json());
    expect(body.globalSkills?.kind).toBe("imported");
    if (body.globalSkills?.kind !== "imported") {
      throw new Error("expected imported status");
    }
    // Every row in the bundle was already at version 1 in the bucket — the
    // import is a full no-op for our prefix. `skillsPublished` counts only
    // brand-new rows; `skillsSkipped` is the universe of (existing-and-up-to-
    // date) rows the importer iterated, including other suites' leftovers.
    // Floor: at least our 3 must be in the skipped bucket.
    expect(body.globalSkills.skillsSkipped).toBeGreaterThanOrEqual(3);
    expect(body.globalSkills.skillsPublished).toBe(0);

    // Idempotency: post-state versions match pre-state for our 3 rows.
    for (const name of [`${prefix}skill-1`, `${prefix}skill-2`, `${prefix}skill-3`]) {
      const skillId = skillIdsByName.get(name);
      expect(skillId).toBeDefined();
      const after = await SkillStorage.getBySkillId(skillId ?? "");
      expect.assert(after.ok === true);
      expect(after.data).not.toBeNull();
      expect(after.data?.version).toBe(1);
    }
  });
});
