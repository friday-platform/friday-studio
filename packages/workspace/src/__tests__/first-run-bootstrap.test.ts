import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { WorkspaceConfigSchema } from "@atlas/config";
import { createKVStorage } from "@atlas/storage";
import { parse } from "@std/yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceManager } from "../manager.ts";
import { RegistryStorageAdapter } from "../registry-storage-adapter.ts";

const hoisted = vi.hoisted(() => ({ atlasHome: "/tmp/atlas-first-run-default" }));

vi.mock("@atlas/utils/paths.server", () => ({ getFridayHome: () => hoisted.atlasHome }));

vi.mock("@atlas/system/workspaces", () => ({ SYSTEM_WORKSPACES: {} }));

vi.mock("../watchers/index.ts", () => ({
  WorkspaceConfigWatcher: class {
    watchWorkspace() {
      return Promise.resolve();
    }
    unwatchWorkspace() {}
    stop() {}
    shutdown() {
      return Promise.resolve();
    }
  },
}));

async function setupManager(
  tempDir: string,
): Promise<{ manager: WorkspaceManager; registry: RegistryStorageAdapter }> {
  hoisted.atlasHome = tempDir;
  const kv = await createKVStorage({ type: "memory" });
  const registry = new RegistryStorageAdapter(kv);
  await registry.initialize();
  const manager = new WorkspaceManager(registry);
  return { manager, registry };
}

describe("ensureDefaultUserWorkspace", () => {
  let tempDir: string;
  let manager: WorkspaceManager;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "atlas-first-run-"));
    process.env.DENO_TEST = "true";
    const setup = await setupManager(tempDir);
    manager = setup.manager;
    await manager.initialize([]);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("creates 'user' workspace on fresh registry with zero non-system workspaces", async () => {
    const { ensureDefaultUserWorkspace, USER_WORKSPACE_ID } = await import(
      "../first-run-bootstrap.ts"
    );

    await ensureDefaultUserWorkspace(manager);

    const found = await manager.find({ id: USER_WORKSPACE_ID });
    expect(found).not.toBeNull();
    expect(found?.id).toBe("user");
    expect(found?.name).toBe("Personal");
  });

  it("is a no-op when workspace id='user' already exists", async () => {
    const { ensureDefaultUserWorkspace, USER_WORKSPACE_ID } = await import(
      "../first-run-bootstrap.ts"
    );

    await ensureDefaultUserWorkspace(manager);
    const first = await manager.find({ id: USER_WORKSPACE_ID });

    await ensureDefaultUserWorkspace(manager);
    const second = await manager.find({ id: USER_WORKSPACE_ID });

    expect(first?.createdAt).toBe(second?.createdAt);
  });

  it("still creates 'user' when other non-system workspaces exist", async () => {
    // Earlier behavior bailed out whenever any non-system workspace was
    // present, but that left `POST /api/chat` referencing a missing `user`
    // workspace whenever FAST kernels were already registered. The current
    // contract: only skip if `user` itself already exists.
    const { ensureDefaultUserWorkspace, USER_WORKSPACE_ID } = await import(
      "../first-run-bootstrap.ts"
    );

    const otherDir = join(tempDir, "workspaces", "other");
    await mkdir(otherDir, { recursive: true });
    await writeFile(
      join(otherDir, "workspace.yml"),
      'version: "1.0"\nworkspace:\n  name: "Other"\n',
      "utf-8",
    );
    await manager.registerWorkspace(otherDir);

    await ensureDefaultUserWorkspace(manager);

    const found = await manager.find({ id: USER_WORKSPACE_ID });
    expect(found).not.toBeNull();
    expect(found?.id).toBe("user");
  });

  it("writes workspace.yml that parses through WorkspaceConfigSchema", async () => {
    const { ensureDefaultUserWorkspace } = await import("../first-run-bootstrap.ts");

    await ensureDefaultUserWorkspace(manager);

    const ymlPath = join(tempDir, "workspaces", "user", "workspace.yml");
    expect(existsSync(ymlPath)).toBe(true);

    const raw = readFileSync(ymlPath, "utf-8");
    const parsed = parse(raw);
    const result = WorkspaceConfigSchema.safeParse(parsed);
    expect(result.success).toBe(true);
  });

  it("creates workspace with two-corpus memory baseline (notes + memory)", async () => {
    // Template was simplified from the three-corpus (user-profile, notes,
    // scratchpad) layout to the two-corpus (notes short_term + memory
    // long_term) layout in 5d9f4dbe9 — keep the test aligned with the
    // template so a regression there is caught here.
    const { ensureDefaultUserWorkspace, USER_WORKSPACE_ID } = await import(
      "../first-run-bootstrap.ts"
    );

    await ensureDefaultUserWorkspace(manager);

    const config = await manager.getWorkspaceConfig(USER_WORKSPACE_ID);
    expect(config).not.toBeNull();

    const own = config?.workspace.memory?.own ?? [];
    const names = own.map((e) => e.name);
    expect(names).toContain("notes");
    expect(names).toContain("memory");
  });
});

describe("user-workspace-template.yml schema validation", () => {
  it("parses through WorkspaceConfigSchema", () => {
    const templatePath = fileURLToPath(new URL("../user-workspace-template.yml", import.meta.url));
    const raw = readFileSync(templatePath, "utf-8");
    const parsed = parse(raw);
    const result = WorkspaceConfigSchema.safeParse(parsed);
    expect(result.success).toBe(true);
  });
});
