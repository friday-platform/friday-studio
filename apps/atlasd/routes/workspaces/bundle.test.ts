import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

vi.mock("@atlas/core/workspace-members/storage", () => ({
  WorkspaceMemberStorage: {
    get: vi
      .fn()
      .mockImplementation((userId: string, wsId: string) =>
        Promise.resolve({
          ok: true,
          data: { userId, wsId, role: "owner", addedAt: "2026-05-11T00:00:00.000Z" },
        }),
      ),
    listByUser: vi.fn().mockResolvedValue({ ok: true, data: [] }),
    listByWorkspace: vi.fn().mockResolvedValue({ ok: true, data: [] }),
    put: vi.fn().mockResolvedValue({ ok: true, data: null }),
    putIfAbsent: vi.fn().mockResolvedValue({ ok: true, data: null }),
    delete: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
  },
  ensureWorkspaceMembersKVBucket: vi.fn(),
  initWorkspaceMemberStorage: vi.fn(),
  resetWorkspaceMemberStorageForTests: vi.fn(),
}));

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

async function seedWorkspaceDir(dir: string): Promise<void> {
  await writeFile(
    join(dir, "workspace.yml"),
    "version: '1.0'\nworkspace:\n  name: demo-space\nskills:\n  - '@tempest/hello'\n",
  );
  await mkdir(join(dir, "skills", "hello"), { recursive: true });
  await writeFile(
    join(dir, "skills", "hello", "SKILL.md"),
    "---\nname: hello\ndescription: say hi\n---\n\n# Hello\n",
  );
}

function createApp(opts: {
  workspaceDir: string;
  workspaceId?: string;
  homeDir: string;
  registeredWorkspace?: { id: string; name: string; path: string };
  workspaceConfig?: unknown;
  agentRegistry?: { reload: ReturnType<typeof vi.fn> };
}): {
  app: Hono<AppVariables>;
  registerSpy: ReturnType<typeof vi.fn>;
  reloadSpy: ReturnType<typeof vi.fn>;
} {
  const workspaceId = opts.workspaceId ?? "ws-demo";
  const registerSpy = vi
    .fn()
    // deno-lint-ignore require-await
    .mockImplementation(async (path: string) => ({
      workspace: {
        id: opts.registeredWorkspace?.id ?? "ws-imported",
        name: opts.registeredWorkspace?.name ?? "demo-space",
        path: opts.registeredWorkspace?.path ?? path,
      },
      created: true,
    }));

  const mockManager = {
    find: vi
      .fn()
      .mockResolvedValue({
        id: workspaceId,
        name: "demo-space",
        path: opts.workspaceDir,
        configPath: join(opts.workspaceDir, "workspace.yml"),
        status: "inactive",
        createdAt: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        metadata: {},
      }),
    getWorkspaceConfig: vi
      .fn()
      .mockResolvedValue(
        opts.workspaceConfig ?? {
          atlas: null,
          workspace: { version: "1.0", workspace: { name: "demo-space" } },
        },
      ),
    registerWorkspace: registerSpy,
    list: vi.fn().mockResolvedValue([]),
    deleteWorkspace: vi.fn(),
  } as unknown as WorkspaceManager;

  const mockContext: AppContext = {
    startTime: Date.now(),
    sseClients: new Map(),
    sseStreams: new Map(),
    getWorkspaceManager: () => mockManager,
    daemon: {} as AppContext["daemon"],
    streamRegistry: {} as AppContext["streamRegistry"],
    chatTurnRegistry: {} as AppContext["chatTurnRegistry"],
    sessionStreamRegistry: {} as AppContext["sessionStreamRegistry"],
    sessionHistoryAdapter: {} as AppContext["sessionHistoryAdapter"],
    sessionDispatchRegistry: {} as AppContext["sessionDispatchRegistry"],
    getAgentRegistry: vi.fn().mockReturnValue(opts.agentRegistry),
    getOrCreateChatSdkInstance: vi.fn(),
    exposeKernel: false,
    platformModels: createStubPlatformModels(),
  };

  mockGetAtlasHome.mockReturnValue(opts.homeDir);

  const app = new Hono<AppVariables>();
  app.use("*", async (c, next) => {
    c.set("app", mockContext);
    c.set("userId", "test-user");
    await next();
  });
  app.route("/", workspacesRoutes);
  const reloadSpy = (opts.agentRegistry?.reload ?? vi.fn()) as ReturnType<typeof vi.fn>;
  return { app, registerSpy, reloadSpy };
}

describe("workspace bundle endpoints (end-to-end)", () => {
  let workspaceDir: string;
  let homeDir: string;

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), "bundle-route-ws-"));
    homeDir = await mkdtemp(join(tmpdir(), "bundle-route-home-"));
    await seedWorkspaceDir(workspaceDir);
    mockFetchLinkCredential.mockReset();
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  test("GET /:id/bundle returns a zip containing workspace.yml + skill tree", async () => {
    const { app } = createApp({ workspaceDir, homeDir });

    const response = await app.request("/ws-demo/bundle");

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/zip");
    expect(response.headers.get("Content-Disposition")).toContain("demo-space.zip");

    const zipBytes = new Uint8Array(await response.arrayBuffer());
    const zip = await JSZip.loadAsync(zipBytes);

    expect(zip.file("workspace.yml")).toBeTruthy();
    expect(zip.file("workspace.lock")).toBeTruthy();
    expect(zip.file("skills/hello/SKILL.md")).toBeTruthy();

    const lockfile = await zip.file("workspace.lock")?.async("string");
    expect(lockfile).toContain("mode: definition");
    expect(lockfile).toContain("hello");
  });

  test("POST /import-bundle unzips the bundle and registers the workspace", async () => {
    const { app: exportApp } = createApp({ workspaceDir, homeDir });
    const exportResponse = await exportApp.request("/ws-demo/bundle");
    const zipBytes = new Uint8Array(await exportResponse.arrayBuffer());

    const { app: importApp, registerSpy } = createApp({
      workspaceDir,
      homeDir,
      registeredWorkspace: { id: "ws-new", name: "demo-space", path: join(homeDir, "imported") },
    });

    const form = new FormData();
    form.set("bundle", new File([zipBytes], "demo.zip", { type: "application/zip" }));
    const importResponse = await importApp.request("/import-bundle", {
      method: "POST",
      body: form,
    });

    expect(importResponse.status).toBe(200);
    const body = (await importResponse.json()) as {
      workspaceId: string;
      path: string;
      primitives: { kind: string; name: string }[];
    };
    expect(body.workspaceId).toBe("ws-new");
    expect(body.path).toContain(homeDir);
    expect(body.primitives).toEqual([{ kind: "skill", name: "hello", path: "skills/hello" }]);

    expect(registerSpy).toHaveBeenCalledTimes(1);
    const registeredPath = registerSpy.mock.calls[0]?.[0] as string;
    await access(join(registeredPath, "skills", "hello", "SKILL.md"));
    const yml = await readFile(join(registeredPath, "workspace.yml"), "utf-8");
    expect(yml).toContain("demo-space");
  });

  test("GET /:id/bundle includes user agents installed under <atlasHome>/agents", async () => {
    // User agent referenced by workspace.yml lives globally at
    // <atlasHome>/agents/<id>@<version>/ — bundle-helpers must resolve it.
    const agentSrc = join(homeDir, "agents", "spritesheet-normalizer@1.0.0");
    await mkdir(agentSrc, { recursive: true });
    await writeFile(
      join(agentSrc, "metadata.json"),
      JSON.stringify({
        id: "spritesheet-normalizer",
        version: "1.0.0",
        description: "Normalizes a spritesheet",
      }),
    );
    await writeFile(join(agentSrc, "agent.py"), "print('normalize')\n");

    const { app } = createApp({
      workspaceDir,
      homeDir,
      workspaceConfig: {
        atlas: null,
        workspace: {
          version: "1.0",
          workspace: { name: "demo-space" },
          agents: {
            "spritesheet-normalizer": {
              type: "user",
              agent: "spritesheet-normalizer",
              description: "Normalizes a spritesheet",
            },
          },
        },
      },
    });

    const response = await app.request("/ws-demo/bundle");
    expect(response.status).toBe(200);

    const zip = await JSZip.loadAsync(new Uint8Array(await response.arrayBuffer()));
    expect(zip.file("agents/spritesheet-normalizer/agent.py")).toBeTruthy();
    expect(zip.file("agents/spritesheet-normalizer/metadata.json")).toBeTruthy();
    const lockfile = await zip.file("workspace.lock")?.async("string");
    expect(lockfile).toContain("spritesheet-normalizer");
    expect(lockfile).toContain("agents/spritesheet-normalizer");
  });

  test("GET /:id/bundle fails when a referenced user agent isn't installed", async () => {
    // Nothing seeded under <homeDir>/agents/ — referenced user agent is
    // unresolvable, export should fail loudly instead of producing a
    // half-empty bundle.
    const { app } = createApp({
      workspaceDir,
      homeDir,
      workspaceConfig: {
        atlas: null,
        workspace: {
          version: "1.0",
          workspace: { name: "demo-space" },
          agents: {
            ghost: {
              type: "user",
              agent: "ghost",
              description: "agent that does not exist on disk",
            },
          },
        },
      },
    });

    const response = await app.request("/ws-demo/bundle");
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/user agent.*could not be resolved/i);
    expect(body.error).toContain("ghost");
  });

  test("POST /import-bundle installs bundled user agents globally and reloads registry", async () => {
    // Export: source workspace.yml references a user agent that lives at
    // <homeDir>/agents/<id>@<version>/; exportBundle embeds it under
    // agents/<name>/ in the zip.
    const agentSrc = join(homeDir, "agents", "spritesheet-normalizer@1.0.0");
    await mkdir(agentSrc, { recursive: true });
    await writeFile(
      join(agentSrc, "metadata.json"),
      JSON.stringify({
        id: "spritesheet-normalizer",
        version: "1.0.0",
        description: "Normalizes a spritesheet",
      }),
    );
    await writeFile(join(agentSrc, "agent.py"), "print('normalize')\n");

    const workspaceWithAgent = {
      atlas: null,
      workspace: {
        version: "1.0",
        workspace: { name: "demo-space" },
        agents: {
          "spritesheet-normalizer": {
            type: "user",
            agent: "spritesheet-normalizer",
            description: "Normalizes a spritesheet",
          },
        },
        signals: {
          normalize: {
            description: "Trigger spritesheet normalization",
            provider: "http",
            config: { path: "/normalize" },
          },
        },
        jobs: {
          normalize: {
            triggers: [{ signal: "normalize" }],
            execution: { strategy: "sequential", agents: ["spritesheet-normalizer"] },
          },
        },
      },
    };
    const { app: exportApp } = createApp({
      workspaceDir,
      homeDir,
      workspaceConfig: workspaceWithAgent,
    });
    const exportResponse = await exportApp.request("/ws-demo/bundle");
    expect(exportResponse.status).toBe(200);
    const zipBytes = new Uint8Array(await exportResponse.arrayBuffer());

    // Simulate "importing on a different machine": wipe the global agent
    // install so we can prove the import path repopulates it.
    await rm(join(homeDir, "agents"), { recursive: true, force: true });

    const reload = vi.fn(() => Promise.resolve());
    const { app: importApp, reloadSpy } = createApp({
      workspaceDir,
      homeDir,
      registeredWorkspace: { id: "ws-new", name: "demo-space", path: join(homeDir, "imported") },
      agentRegistry: { reload },
    });

    const form = new FormData();
    form.set("bundle", new File([zipBytes], "demo.zip", { type: "application/zip" }));
    const importResponse = await importApp.request("/import-bundle", {
      method: "POST",
      body: form,
    });

    expect(importResponse.status).toBe(200);
    const body = (await importResponse.json()) as {
      workspaceId: string;
      primitives: { kind: string; name: string }[];
      agentsInstalled: number;
      agentsSkipped: number;
    };
    expect(body.primitives).toEqual(
      expect.arrayContaining([
        { kind: "agent", name: "spritesheet-normalizer", path: "agents/spritesheet-normalizer" },
      ]),
    );
    expect(body.agentsInstalled).toBe(1);
    expect(body.agentsSkipped).toBe(0);

    // Agent must now live at <homeDir>/agents/<id>@<version>/ where the
    // AgentRegistry's UserAdapter scans, not just at <importedWs>/agents/<name>/.
    await access(join(homeDir, "agents", "spritesheet-normalizer@1.0.0", "metadata.json"));
    await access(join(homeDir, "agents", "spritesheet-normalizer@1.0.0", "agent.py"));

    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  test("POST /import-bundle skips installing user agents when same id@version already present", async () => {
    // Seed a global install that the import must NOT clobber. The bundle's
    // copy is still extracted to <targetDir>/agents/ for hash verification,
    // but the global install remains untouched and we report it as skipped.
    const agentSrc = join(homeDir, "agents", "spritesheet-normalizer@1.0.0");
    await mkdir(agentSrc, { recursive: true });
    await writeFile(
      join(agentSrc, "metadata.json"),
      JSON.stringify({
        id: "spritesheet-normalizer",
        version: "1.0.0",
        description: "Normalizes a spritesheet",
      }),
    );
    await writeFile(join(agentSrc, "agent.py"), "print('normalize')\n");

    const workspaceWithAgent = {
      atlas: null,
      workspace: {
        version: "1.0",
        workspace: { name: "demo-space" },
        agents: {
          "spritesheet-normalizer": {
            type: "user",
            agent: "spritesheet-normalizer",
            description: "Normalizes a spritesheet",
          },
        },
        signals: {
          normalize: {
            description: "Trigger spritesheet normalization",
            provider: "http",
            config: { path: "/normalize" },
          },
        },
        jobs: {
          normalize: {
            triggers: [{ signal: "normalize" }],
            execution: { strategy: "sequential", agents: ["spritesheet-normalizer"] },
          },
        },
      },
    };
    const { app: exportApp } = createApp({
      workspaceDir,
      homeDir,
      workspaceConfig: workspaceWithAgent,
    });
    const exportResponse = await exportApp.request("/ws-demo/bundle");
    expect(exportResponse.status).toBe(200);
    const zipBytes = new Uint8Array(await exportResponse.arrayBuffer());

    const reload = vi.fn(() => Promise.resolve());
    const { app: importApp } = createApp({
      workspaceDir,
      homeDir,
      registeredWorkspace: { id: "ws-new", name: "demo-space", path: join(homeDir, "imported") },
      agentRegistry: { reload },
    });

    const form = new FormData();
    form.set("bundle", new File([zipBytes], "demo.zip", { type: "application/zip" }));
    const importResponse = await importApp.request("/import-bundle", {
      method: "POST",
      body: form,
    });

    expect(importResponse.status).toBe(200);
    const body = (await importResponse.json()) as {
      agentsInstalled: number;
      agentsSkipped: number;
    };
    expect(body.agentsInstalled).toBe(0);
    expect(body.agentsSkipped).toBe(1);
    // No reload when nothing actually changed.
    expect(reload).not.toHaveBeenCalled();

    // Pre-existing global install is untouched.
    await access(join(homeDir, "agents", "spritesheet-normalizer@1.0.0", "metadata.json"));
  });

  test("POST /import-bundle rejects a tampered bundle", async () => {
    const { app: exportApp } = createApp({ workspaceDir, homeDir });
    const exportResponse = await exportApp.request("/ws-demo/bundle");
    const zipBytes = new Uint8Array(await exportResponse.arrayBuffer());

    const zip = await JSZip.loadAsync(zipBytes);
    zip.file("skills/hello/SKILL.md", "tampered\n");
    const tampered = new Uint8Array(await zip.generateAsync({ type: "uint8array" }));

    const { app: importApp } = createApp({ workspaceDir, homeDir });
    const form = new FormData();
    form.set("bundle", new File([tampered], "tampered.zip", { type: "application/zip" }));
    const response = await importApp.request("/import-bundle", { method: "POST", body: form });

    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/integrity check failed/);
  });
});
