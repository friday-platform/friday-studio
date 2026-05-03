import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStubPlatformModels } from "@atlas/llm";
import type { WorkspaceManager } from "@atlas/workspace";
import { Hono } from "hono";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
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
});
