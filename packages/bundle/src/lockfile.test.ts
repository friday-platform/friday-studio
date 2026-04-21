import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Lockfile, LockfileSchema, readLockfile, writeLockfile } from "./lockfile.ts";

function makeDefinitionLockfile(): Lockfile {
  return {
    schemaVersion: 1,
    mode: "definition",
    workspace: { name: "test-space", version: "1.0.0" },
    primitives: {
      skills: {
        "@tempest/example": {
          hash: "sha256:" + "a".repeat(64),
          path: "skills/example",
        },
      },
      agents: {},
    },
  };
}

function makeMigrationLockfile(): Lockfile {
  return {
    ...makeDefinitionLockfile(),
    mode: "migration",
    snapshots: {
      memory: {
        "dispatch-log": {
          backend: "md-narrative",
          digest: "sha256:" + "b".repeat(64),
          path: "memory/dispatch-log/snapshot.bin",
        },
      },
      resources: {},
      history: null,
    },
  };
}

describe("LockfileSchema", () => {
  it("accepts a valid definition-mode lockfile", () => {
    const result = LockfileSchema.safeParse(makeDefinitionLockfile());
    expect(result.success).toBe(true);
  });

  it("accepts a valid migration-mode lockfile", () => {
    const result = LockfileSchema.safeParse(makeMigrationLockfile());
    expect(result.success).toBe(true);
  });

  it("rejects definition-mode lockfile with snapshots section", () => {
    const bad = { ...makeDefinitionLockfile(), snapshots: { memory: {}, resources: {}, history: null } };
    const result = LockfileSchema.safeParse(bad);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/definition-mode/);
    }
  });

  it("rejects migration-mode lockfile without snapshots section", () => {
    const bad = { ...makeMigrationLockfile(), snapshots: undefined };
    const result = LockfileSchema.safeParse(bad);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/migration-mode/);
    }
  });

  it("rejects malformed sha256 hash strings", () => {
    const bad = makeDefinitionLockfile();
    bad.primitives.skills["@tempest/example"] = { hash: "not-a-hash", path: "skills/example" };
    const result = LockfileSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("rejects wrong schemaVersion", () => {
    const bad = { ...makeDefinitionLockfile(), schemaVersion: 2 };
    const result = LockfileSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });
});

describe("readLockfile + writeLockfile", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "bundle-lockfile-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips a definition-mode lockfile", async () => {
    const path = join(dir, "workspace.lock");
    const original = makeDefinitionLockfile();
    await writeLockfile(path, original);
    const read = await readLockfile(path);
    expect(read).toEqual(original);
  });

  it("round-trips a migration-mode lockfile", async () => {
    const path = join(dir, "workspace.lock");
    const original = makeMigrationLockfile();
    await writeLockfile(path, original);
    const read = await readLockfile(path);
    expect(read).toEqual(original);
  });

  it("produces a human-readable YAML file", async () => {
    const path = join(dir, "workspace.lock");
    await writeLockfile(path, makeDefinitionLockfile());
    const yaml = await readFile(path, "utf-8");
    expect(yaml).toContain("schemaVersion: 1");
    expect(yaml).toContain("mode: definition");
    expect(yaml).toContain("@tempest/example");
  });

  it("rejects reading a YAML file that fails schema validation", async () => {
    const path = join(dir, "workspace.lock");
    await writeFile(path, "schemaVersion: 1\nmode: wrong\n", "utf-8");
    await expect(readLockfile(path)).rejects.toThrow();
  });
});
