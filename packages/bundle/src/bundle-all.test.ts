import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exportBundle } from "./bundle.ts";
import { exportAll, FullManifestSchema, importAll, readFullManifest } from "./bundle-all.ts";

async function seedWorkspace(dir: string, name: string, includeAgent = true) {
  await writeFile(join(dir, "workspace.yml"), `version: '1.0'\nworkspace:\n  name: ${name}\n`);
  if (includeAgent) {
    await mkdir(join(dir, "agents", "hello-bot"), { recursive: true });
    await writeFile(join(dir, "agents", "hello-bot", "agent.py"), "# hello\n");
  }
}

async function buildBundle(workDir: string, name: string): Promise<Uint8Array> {
  return exportBundle({
    workspaceDir: workDir,
    workspaceYml: `version: '1.0'\nworkspace:\n  name: ${name}\n`,
    mode: "definition",
    workspace: { name, version: "1.0.0" },
  });
}

describe("exportAll + importAll round-trip", () => {
  let srcA: string;
  let srcB: string;
  let targetRoot: string;

  beforeEach(async () => {
    srcA = await mkdtemp(join(tmpdir(), "bundle-all-a-"));
    srcB = await mkdtemp(join(tmpdir(), "bundle-all-b-"));
    targetRoot = await mkdtemp(join(tmpdir(), "bundle-all-target-"));
    await seedWorkspace(srcA, "Alpha");
    await seedWorkspace(srcB, "Beta", false);
  });

  afterEach(async () => {
    await rm(srcA, { recursive: true, force: true });
    await rm(srcB, { recursive: true, force: true });
    await rm(targetRoot, { recursive: true, force: true });
  });

  it("round-trips two workspaces through the outer archive", async () => {
    const bundleA = await buildBundle(srcA, "Alpha");
    const bundleB = await buildBundle(srcB, "Beta");

    const full = await exportAll({
      workspaces: [
        { id: "src-alpha", name: "Alpha", bundleBytes: bundleA },
        { id: "src-beta", name: "Beta", bundleBytes: bundleB },
      ],
      mode: "definition",
      atlasVersion: "test",
    });

    const manifest = await readFullManifest(full);
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.mode).toBe("definition");
    expect(manifest.entries.map((e) => e.name)).toEqual(["Alpha", "Beta"]);
    expect(manifest.entries.map((e) => e.path)).toEqual([
      "workspaces/src-alpha.zip",
      "workspaces/src-beta.zip",
    ]);
    expect(manifest.reserved.global.skills).toBeNull();
    expect(manifest.reserved.global.memory).toBeNull();

    const result = await importAll({ zipBytes: full, workspacesRoot: targetRoot });
    expect(result.errors).toEqual([]);
    expect(result.imported).toHaveLength(2);
    expect(result.imported.map((e) => e.name).sort()).toEqual(["Alpha", "Beta"]);

    // Per-workspace dirs materialized, distinct, each on disk.
    const dirs = await readdir(targetRoot);
    expect(dirs).toHaveLength(2);
    expect(new Set(dirs).size).toBe(2);

    // Alpha has its agent file; Beta doesn't (was seeded without).
    const alphaDir = result.imported.find((e) => e.name === "Alpha")?.path;
    const betaDir = result.imported.find((e) => e.name === "Beta")?.path;
    expect(alphaDir).toBeDefined();
    expect(betaDir).toBeDefined();

    const alphaPrimitives = result.imported.find((e) => e.name === "Alpha")?.primitives ?? [];
    expect(alphaPrimitives.map((p) => p.name)).toContain("hello-bot");
    const betaPrimitives = result.imported.find((e) => e.name === "Beta")?.primitives ?? [];
    expect(betaPrimitives).toHaveLength(0);
  });

  it("uses a per-entry suffix so intra-call dirs do not collide", async () => {
    const b1 = await buildBundle(srcA, "Same");
    const b2 = await buildBundle(srcB, "Same");
    const full = await exportAll({
      workspaces: [
        { id: "one", name: "Same", bundleBytes: b1 },
        { id: "two", name: "Same", bundleBytes: b2 },
      ],
      mode: "definition",
    });
    const result = await importAll({ zipBytes: full, workspacesRoot: targetRoot });
    expect(result.errors).toEqual([]);
    expect(result.imported).toHaveLength(2);
    expect(new Set(result.imported.map((e) => e.path)).size).toBe(2);
  });

  it("records an error but continues when an inner bundle is corrupt", async () => {
    const good = await buildBundle(srcA, "Good");
    const bad = new Uint8Array([0, 1, 2, 3]);
    const full = await exportAll({
      workspaces: [
        { id: "good", name: "Good", bundleBytes: good },
        { id: "bad", name: "Bad", bundleBytes: bad },
      ],
      mode: "definition",
    });
    const result = await importAll({ zipBytes: full, workspacesRoot: targetRoot });
    expect(result.imported.map((e) => e.name)).toEqual(["Good"]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.name).toBe("Bad");
  });

  it("rejects an archive missing manifest.yml", async () => {
    const empty = new Uint8Array([
      0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    await expect(readFullManifest(empty)).rejects.toThrow(/missing manifest\.yml/);
  });

  it("emits reserved.global slots as null in manifest", async () => {
    const good = await buildBundle(srcA, "One");
    const full = await exportAll({
      workspaces: [{ id: "one", name: "One", bundleBytes: good }],
      mode: "definition",
    });
    const manifest = await readFullManifest(full);
    // Downstream readers should be able to tolerate these as null and future non-null.
    expect(FullManifestSchema.parse(manifest)).toEqual(manifest);
    expect(manifest.reserved.global.skills).toBeNull();
  });

  it("embeds global.skills bytes and flips the manifest slot when provided", async () => {
    const inner = await buildBundle(srcA, "One");
    const fakeSkills = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const full = await exportAll({
      workspaces: [{ id: "one", name: "One", bundleBytes: inner }],
      mode: "definition",
      global: { skills: fakeSkills },
    });
    const manifest = await readFullManifest(full);
    expect(manifest.reserved.global.skills).toBe("global/skills.zip");

    const result = await importAll({ zipBytes: full, workspacesRoot: targetRoot });
    expect(result.globalSkillsBytes).toBeDefined();
    expect(Array.from(result.globalSkillsBytes ?? new Uint8Array())).toEqual(
      Array.from(fakeSkills),
    );
  });
});
