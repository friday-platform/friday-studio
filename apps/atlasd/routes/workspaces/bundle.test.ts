import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportAll } from "@atlas/bundle";
import { createStubPlatformModels } from "@atlas/llm";
import { createLogger } from "@atlas/logger";
import type { WorkspaceManager } from "@atlas/workspace";
import { Hono } from "hono";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AppContext, AppVariables } from "../../src/factory.ts";
import { installImportedAgents } from "./bundle-helpers.ts";
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

  test("POST /import-bundle-all installs bundled user agents from each inner workspace", async () => {
    // Build a workspace with a user agent, export it as a bundle, then wrap
    // it in a manifest-style outer archive so we can import via
    // /import-bundle-all. Asserts the install + reload path fires from the
    // multi-workspace route, not just /import-bundle.
    const agentSrc = join(homeDir, "agents", "writer@1.0.0");
    await mkdir(agentSrc, { recursive: true });
    await writeFile(
      join(agentSrc, "metadata.json"),
      JSON.stringify({ id: "writer", version: "1.0.0", description: "Writes" }),
    );
    await writeFile(join(agentSrc, "agent.py"), "print('write')\n");

    const wsConfig = {
      atlas: null,
      workspace: {
        version: "1.0",
        workspace: { name: "demo-space" },
        agents: { writer: { type: "user", agent: "writer", description: "Writes" } },
        signals: { write: { description: "Write", provider: "http", config: { path: "/write" } } },
        jobs: {
          write: {
            triggers: [{ signal: "write" }],
            execution: { strategy: "sequential", agents: ["writer"] },
          },
        },
      },
    };

    const { app: exportApp } = createApp({ workspaceDir, homeDir, workspaceConfig: wsConfig });
    const innerResp = await exportApp.request("/ws-demo/bundle");
    expect(innerResp.status).toBe(200);
    const innerBytes = new Uint8Array(await innerResp.arrayBuffer());

    // Wrap the inner bundle in a real outer envelope so the manifest matches
    // FullManifestSchema. Importing a hand-rolled YAML manifest would tightly
    // couple this test to the schema's evolution.
    const outerBytes = new Uint8Array(
      await exportAll({
        mode: "definition",
        workspaces: [{ id: "ws-demo", name: "demo-space", bundleBytes: innerBytes }],
      }),
    );

    // Clean the global agent install so we can prove import-bundle-all
    // repopulates it on a fresh machine.
    await rm(join(homeDir, "agents"), { recursive: true, force: true });

    const reload = vi.fn(() => Promise.resolve());
    const { app: importApp } = createApp({
      workspaceDir,
      homeDir,
      registeredWorkspace: { id: "ws-new", name: "demo-space", path: join(homeDir, "imported") },
      agentRegistry: { reload },
    });

    const form = new FormData();
    form.set("bundle", new File([outerBytes], "all.zip", { type: "application/zip" }));
    const resp = await importApp.request("/import-bundle-all", { method: "POST", body: form });

    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      imported: Array<{ name: string; agentsInstalled?: number; agentsSkipped?: number }>;
      errors: Array<{ name: string; error: string }>;
    };
    expect(body.errors).toEqual([]);
    expect(body.imported).toHaveLength(1);
    expect(body.imported[0]?.agentsInstalled).toBe(1);
    expect(body.imported[0]?.agentsSkipped).toBe(0);

    await access(join(homeDir, "agents", "writer@1.0.0", "metadata.json"));
    expect(reload).toHaveBeenCalledTimes(1);
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

// Unit tests for installImportedAgents — constructed inputs are cheaper here
// than synthesizing bundles that round-trip integrity checks. The HTTP-level
// tests above already cover the happy path through the route.
describe("installImportedAgents (unit)", () => {
  let targetDir: string;
  let atlasHome: string;
  const logger = createLogger({ component: "installImportedAgents-test" });

  beforeEach(async () => {
    targetDir = await mkdtemp(join(tmpdir(), "iia-target-"));
    atlasHome = await mkdtemp(join(tmpdir(), "iia-home-"));
  });

  afterEach(async () => {
    await rm(targetDir, { recursive: true, force: true });
    await rm(atlasHome, { recursive: true, force: true });
  });

  async function seedBundledAgent(opts: {
    /** Directory name inside `<targetDir>/agents/`. Mirrors `primitive.name`. */
    bundleName: string;
    /** Contents of `metadata.json`. Pass an unparseable string to simulate corruption. */
    metadata: Record<string, unknown> | string;
    /** Extra files to drop alongside `metadata.json`. Defaults to a stub agent.py. */
    files?: Record<string, string>;
  }): Promise<{ kind: "agent"; name: string; path: string }> {
    const dir = join(targetDir, "agents", opts.bundleName);
    await mkdir(dir, { recursive: true });
    const md = typeof opts.metadata === "string" ? opts.metadata : JSON.stringify(opts.metadata);
    await writeFile(join(dir, "metadata.json"), md);
    const extras = opts.files ?? { "agent.py": "print('x')\n" };
    for (const [rel, body] of Object.entries(extras)) {
      await writeFile(join(dir, rel), body);
    }
    return { kind: "agent", name: opts.bundleName, path: `agents/${opts.bundleName}` };
  }

  test("rejects path-traversal id, never writes outside agents root", async () => {
    // Use a sibling temp dir as the would-be traversal target. We can't
    // assert "system /etc/cron.d doesn't exist" — on a Linux CI runner it
    // does — so we set up an attacker-controllable target *next to*
    // atlasHome and check that nothing was created in it.
    const traversalParent = await mkdtemp(join(tmpdir(), "iia-traversal-"));
    try {
      // From `<atlasHome>/agents/<id>@<version>/`, two `..` walks up to
      // `<atlasHome>/`. Adding the basename of traversalParent + a sentinel
      // lands writes at `<atlasHome>/../<traversalParent basename>/sentinel`,
      // which path-resolves to inside traversalParent.
      const parentName = traversalParent.split("/").pop();
      if (!parentName) throw new Error("could not derive parent dirname");
      const maliciousId = `../../${parentName}/sentinel`;

      const primitive = await seedBundledAgent({
        bundleName: "tricky",
        metadata: {
          id: maliciousId,
          version: "1.0.0",
          description: "Malicious id with path traversal",
        },
        files: { "payload.txt": "PWNED\n" },
      });

      const result = await installImportedAgents({
        targetDir,
        primitives: [primitive],
        atlasHome,
        logger,
      });

      expect(result.installed).toEqual([]);
      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0]?.reason).toMatch(/unsafe id\/version/);

      // The attacker-controlled location must not have been written to.
      await expect(access(join(traversalParent, "sentinel@1.0.0"))).rejects.toThrow();
      await expect(
        access(join(traversalParent, "sentinel@1.0.0", "payload.txt")),
      ).rejects.toThrow();

      // And the legitimate agents root has no entries.
      const agentsRoot = join(atlasHome, "agents");
      const { readdir } = await import("node:fs/promises");
      const entries = await readdir(agentsRoot).catch(() => []);
      expect(entries).toEqual([]);
    } finally {
      await rm(traversalParent, { recursive: true, force: true });
    }
  });

  test("rejects path-traversal version", async () => {
    const primitive = await seedBundledAgent({
      bundleName: "tricky2",
      metadata: { id: "agent", version: "../1.0.0", description: "Bad version" },
    });

    const result = await installImportedAgents({
      targetDir,
      primitives: [primitive],
      atlasHome,
      logger,
    });

    expect(result.installed).toEqual([]);
    expect(result.skipped[0]?.reason).toMatch(/unsafe id\/version/);
  });

  test("rejects metadata.json that doesn't match the schema (missing description)", async () => {
    const primitive = await seedBundledAgent({
      bundleName: "incomplete",
      metadata: { id: "incomplete", version: "1.0.0" }, // description missing
    });

    const result = await installImportedAgents({
      targetDir,
      primitives: [primitive],
      atlasHome,
      logger,
    });

    expect(result.installed).toEqual([]);
    expect(result.skipped[0]?.reason).toMatch(/invalid metadata\.json/);
  });

  test("rejects unparseable metadata.json without aborting other agents in the batch", async () => {
    const bad = await seedBundledAgent({ bundleName: "bad", metadata: "{ not json" });
    const good = await seedBundledAgent({
      bundleName: "good",
      metadata: { id: "good", version: "1.0.0", description: "ok" },
    });

    const result = await installImportedAgents({
      targetDir,
      primitives: [bad, good],
      atlasHome,
      logger,
    });

    expect(result.installed.map((a) => a.id)).toEqual(["good"]);
    expect(result.skipped.map((s) => s.name)).toEqual(["bad"]);
    await access(join(atlasHome, "agents", "good@1.0.0", "metadata.json"));
  });

  test("flags content divergence when same id@version is already installed with different bytes", async () => {
    // Seed the global install with one body...
    const installedDir = join(atlasHome, "agents", "shared@1.0.0");
    await mkdir(installedDir, { recursive: true });
    await writeFile(
      join(installedDir, "metadata.json"),
      JSON.stringify({ id: "shared", version: "1.0.0", description: "v1 globally installed" }),
    );
    await writeFile(join(installedDir, "agent.py"), "print('GLOBAL VERSION')\n");

    // ...and the bundle ships a different body under the same id@version.
    const primitive = await seedBundledAgent({
      bundleName: "shared",
      metadata: { id: "shared", version: "1.0.0", description: "v1 from bundle" },
      files: { "agent.py": "print('BUNDLE VERSION')\n" },
    });

    const result = await installImportedAgents({
      targetDir,
      primitives: [primitive],
      atlasHome,
      logger,
    });

    expect(result.installed).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toMatch(/content diverges from bundle/);

    // Global install untouched (still has the GLOBAL VERSION body).
    const installedBody = await readFile(join(installedDir, "agent.py"), "utf-8");
    expect(installedBody).toContain("GLOBAL VERSION");
  });

  test("clean skip (no divergence warning) when same id@version is byte-identical", async () => {
    const metadata = { id: "shared", version: "1.0.0", description: "same on both sides" };
    const agentBody = "print('same')\n";

    const installedDir = join(atlasHome, "agents", "shared@1.0.0");
    await mkdir(installedDir, { recursive: true });
    await writeFile(join(installedDir, "metadata.json"), JSON.stringify(metadata));
    await writeFile(join(installedDir, "agent.py"), agentBody);

    const primitive = await seedBundledAgent({
      bundleName: "shared",
      metadata,
      files: { "agent.py": agentBody },
    });

    const result = await installImportedAgents({
      targetDir,
      primitives: [primitive],
      atlasHome,
      logger,
    });

    expect(result.installed).toEqual([]);
    expect(result.skipped[0]?.reason).not.toMatch(/diverges/);
    expect(result.skipped[0]?.reason).toMatch(/already installed/);
  });
});
