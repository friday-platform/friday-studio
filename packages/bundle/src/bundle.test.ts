import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exportBundle, importBundle, verifyWorkspace } from "./bundle.ts";

async function seedWorkspace(dir: string) {
  await writeFile(
    join(dir, "workspace.yml"),
    "version: '1.0'\nworkspace:\n  name: Demo\nskills:\n  - '@tempest/hello'\n",
  );
  await mkdir(join(dir, "skills", "hello"), { recursive: true });
  await writeFile(
    join(dir, "skills", "hello", "SKILL.md"),
    "---\nname: hello\ndescription: say hi\n---\n\n# Hello\n",
  );
  await writeFile(join(dir, "skills", "hello", "reference.txt"), "ref\n");
}

describe("exportBundle + importBundle round-trip", () => {
  let workDir: string;
  let importDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "bundle-src-"));
    importDir = await mkdtemp(join(tmpdir(), "bundle-dst-"));
    await rm(importDir, { recursive: true, force: true });
    await seedWorkspace(workDir);
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
    await rm(importDir, { recursive: true, force: true });
    await rm(importDir + ".staging", { recursive: true, force: true });
  });

  it("exports a definition-only bundle and re-imports identically", async () => {
    const zipBytes = await exportBundle({
      workspaceDir: workDir,
      workspaceYml: await readFile(join(workDir, "workspace.yml"), "utf-8"),
      mode: "definition",
      workspace: { name: "demo", version: "1.0.0" },
    });

    const result = await importBundle({ zipBytes, targetDir: importDir });

    expect(result.primitives).toEqual([{ kind: "skill", name: "hello", path: "skills/hello" }]);
    expect(result.lockfile.mode).toBe("definition");
    expect(result.lockfile.workspace.name).toBe("demo");

    const skillBody = await readFile(join(importDir, "skills", "hello", "SKILL.md"), "utf-8");
    expect(skillBody).toContain("# Hello");
  });

  it("rejects a tampered bundle (primitive content mutated after hashing)", async () => {
    const zipBytes = await exportBundle({
      workspaceDir: workDir,
      workspaceYml: await readFile(join(workDir, "workspace.yml"), "utf-8"),
      mode: "definition",
      workspace: { name: "demo", version: "1.0.0" },
    });

    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(zipBytes);
    zip.file("skills/hello/SKILL.md", "tampered content\n");
    const tampered = await zip.generateAsync({ type: "uint8array" });

    await expect(importBundle({ zipBytes: tampered, targetDir: importDir })).rejects.toThrow(
      /integrity check failed/,
    );
  });

  it("leaves no partial state on tampered import", async () => {
    const zipBytes = await exportBundle({
      workspaceDir: workDir,
      workspaceYml: await readFile(join(workDir, "workspace.yml"), "utf-8"),
      mode: "definition",
      workspace: { name: "demo", version: "1.0.0" },
    });
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(zipBytes);
    zip.file("skills/hello/SKILL.md", "tampered\n");
    const tampered = await zip.generateAsync({ type: "uint8array" });

    await expect(importBundle({ zipBytes: tampered, targetDir: importDir })).rejects.toThrow();

    const { access } = await import("node:fs/promises");
    await expect(access(importDir)).rejects.toThrow();
    await expect(access(importDir + ".staging")).rejects.toThrow();
  });

  it("verifyWorkspace reports ok for a freshly imported workspace", async () => {
    const zipBytes = await exportBundle({
      workspaceDir: workDir,
      workspaceYml: await readFile(join(workDir, "workspace.yml"), "utf-8"),
      mode: "definition",
      workspace: { name: "demo", version: "1.0.0" },
    });
    await importBundle({ zipBytes, targetDir: importDir });

    const result = await verifyWorkspace(importDir);
    expect(result.ok).toBe(true);
    expect(result.mismatches).toEqual([]);
  });

  it("verifyWorkspace surfaces mismatches after on-disk tampering", async () => {
    const zipBytes = await exportBundle({
      workspaceDir: workDir,
      workspaceYml: await readFile(join(workDir, "workspace.yml"), "utf-8"),
      mode: "definition",
      workspace: { name: "demo", version: "1.0.0" },
    });
    await importBundle({ zipBytes, targetDir: importDir });

    await writeFile(join(importDir, "skills", "hello", "SKILL.md"), "altered locally\n");
    const result = await verifyWorkspace(importDir);
    expect(result.ok).toBe(false);
    expect(result.mismatches).toEqual(["skill:hello"]);
  });
});

describe("exportBundle/importBundle memory (migration mode)", () => {
  let workDir: string;
  let memoryDir: string;
  let importDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "bundle-mem-src-"));
    memoryDir = await mkdtemp(join(tmpdir(), "bundle-mem-home-"));
    importDir = await mkdtemp(join(tmpdir(), "bundle-mem-dst-"));
    await rm(importDir, { recursive: true, force: true });
    await seedWorkspace(workDir);
    await mkdir(join(memoryDir, "narrative", "backlog"), { recursive: true });
    await writeFile(
      join(memoryDir, "narrative", "backlog", "MEMORY.md"),
      "# Backlog\n- task 1\n- task 2\n",
    );
    await writeFile(
      join(memoryDir, "narrative", "backlog", "entries.jsonl"),
      '{"id":"e1","body":"task 1"}\n{"id":"e2","body":"task 2"}\n',
    );
    await mkdir(join(memoryDir, "narrative", "notes"), { recursive: true });
    await writeFile(join(memoryDir, "narrative", "notes", "MEMORY.md"), "# Notes\n");
  });
  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
    await rm(memoryDir, { recursive: true, force: true });
    await rm(importDir, { recursive: true, force: true });
  });

  it("round-trips narrative memory only in migration mode", async () => {
    const zipBytes = await exportBundle({
      workspaceDir: workDir,
      workspaceYml: await readFile(join(workDir, "workspace.yml"), "utf-8"),
      mode: "migration",
      workspace: { name: "demo", version: "1.0.0" },
      memoryDir,
    });

    const result = await importBundle({ zipBytes, targetDir: importDir });
    const memoryPrimitives = result.primitives.filter((p) => p.kind === "memory");
    expect(memoryPrimitives.map((p) => p.name).sort()).toEqual(["backlog", "notes"]);

    const mdBytes = await readFile(join(importDir, "memory", "backlog", "MEMORY.md"), "utf-8");
    expect(mdBytes).toContain("Backlog");
    const jsonl = await readFile(join(importDir, "memory", "backlog", "entries.jsonl"), "utf-8");
    expect(jsonl.split("\n")).toHaveLength(3);
  });

  it("definition mode ignores memoryDir — no memory entries in bundle", async () => {
    const zipBytes = await exportBundle({
      workspaceDir: workDir,
      workspaceYml: await readFile(join(workDir, "workspace.yml"), "utf-8"),
      mode: "definition",
      workspace: { name: "demo", version: "1.0.0" },
      memoryDir,
    });
    const result = await importBundle({ zipBytes, targetDir: importDir });
    expect(result.primitives.filter((p) => p.kind === "memory")).toEqual([]);
  });

  it("skips empty narrative dirs (no orphan lockfile entries)", async () => {
    await mkdir(join(memoryDir, "narrative", "empty-one"), { recursive: true });
    const zipBytes = await exportBundle({
      workspaceDir: workDir,
      workspaceYml: await readFile(join(workDir, "workspace.yml"), "utf-8"),
      mode: "migration",
      workspace: { name: "demo", version: "1.0.0" },
      memoryDir,
    });
    const result = await importBundle({ zipBytes, targetDir: importDir });
    const memoryNames = result.primitives.filter((p) => p.kind === "memory").map((p) => p.name);
    expect(memoryNames).not.toContain("empty-one");
    expect(memoryNames.sort()).toEqual(["backlog", "notes"]);
  });

  it("detects tampered memory on import", async () => {
    const JSZip = (await import("jszip")).default;
    const zipBytes = await exportBundle({
      workspaceDir: workDir,
      workspaceYml: await readFile(join(workDir, "workspace.yml"), "utf-8"),
      mode: "migration",
      workspace: { name: "demo", version: "1.0.0" },
      memoryDir,
    });
    const zip = await JSZip.loadAsync(zipBytes);
    zip.file("memory/backlog/MEMORY.md", "tampered\n");
    const tampered = new Uint8Array(await zip.generateAsync({ type: "uint8array" }));
    await expect(importBundle({ zipBytes: tampered, targetDir: importDir })).rejects.toThrow(
      /integrity check failed for memory/,
    );
  });
});
