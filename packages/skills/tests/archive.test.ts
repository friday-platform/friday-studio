import { Buffer } from "node:buffer";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTempDir } from "@atlas/utils/temp.server";
import { afterEach, describe, expect, it } from "vitest";
import { extractSkillArchive, injectSkillDir, packSkillArchive } from "../src/archive.ts";

describe("packSkillArchive", () => {
  let tempDirs: string[] = [];

  function createTempDir(prefix?: string): string {
    const dir = makeTempDir({ prefix: prefix ?? "archive-test-" });
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    for (const dir of tempDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    tempDirs = [];
  });

  it("packs a directory with a single file", async () => {
    const dir = createTempDir();
    await writeFile(join(dir, "SKILL.md"), "# Hello");

    const archive = await packSkillArchive(dir);

    expect(Buffer.isBuffer(archive)).toBe(true);
    expect(archive.length).toBeGreaterThan(0);
  });

  it("packs a directory with nested files", async () => {
    const dir = createTempDir();
    await writeFile(join(dir, "SKILL.md"), "# Skill");
    await mkdir(join(dir, "examples"), { recursive: true });
    await writeFile(join(dir, "examples", "sample.md"), "example content");
    await mkdir(join(dir, "scripts"), { recursive: true });
    await writeFile(join(dir, "scripts", "helper.py"), "print('hello')");

    const archive = await packSkillArchive(dir);

    expect(archive.length).toBeGreaterThan(0);
  });

  it("packs an empty directory", async () => {
    const dir = createTempDir();

    const archive = await packSkillArchive(dir);

    expect(Buffer.isBuffer(archive)).toBe(true);
  });
});

describe("extractSkillArchive", () => {
  let tempDirs: string[] = [];

  function createTempDir(prefix?: string): string {
    const dir = makeTempDir({ prefix: prefix ?? "archive-test-" });
    tempDirs.push(dir);
    return dir;
  }

  function trackDir(dir: string): string {
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    for (const dir of tempDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    tempDirs = [];
  });

  it("extracts a tarball and returns a directory path", async () => {
    const dir = createTempDir();
    await writeFile(join(dir, "SKILL.md"), "# Hello");

    const archive = await packSkillArchive(dir);
    const extracted = trackDir(await extractSkillArchive(archive));

    const content = await readFile(join(extracted, "SKILL.md"), "utf-8");
    expect(content).toBe("# Hello");
  });

  it("round-trips nested directory structure", async () => {
    const dir = createTempDir();
    await writeFile(join(dir, "SKILL.md"), "# Skill");
    await mkdir(join(dir, "examples"), { recursive: true });
    await writeFile(join(dir, "examples", "sample.md"), "example content");
    await mkdir(join(dir, "scripts"), { recursive: true });
    await writeFile(join(dir, "scripts", "helper.py"), "print('hello')");

    const archive = await packSkillArchive(dir);
    const extracted = trackDir(await extractSkillArchive(archive));

    const skill = await readFile(join(extracted, "SKILL.md"), "utf-8");
    expect(skill).toBe("# Skill");

    const sample = await readFile(join(extracted, "examples", "sample.md"), "utf-8");
    expect(sample).toBe("example content");

    const helper = await readFile(join(extracted, "scripts", "helper.py"), "utf-8");
    expect(helper).toBe("print('hello')");
  });

  it("uses custom prefix for temp directory", async () => {
    const dir = createTempDir();
    await writeFile(join(dir, "SKILL.md"), "content");

    const archive = await packSkillArchive(dir);
    const extracted = trackDir(await extractSkillArchive(archive, "atlas-skill-"));

    expect(extracted).toContain("atlas-skill-");
  });
});

describe("injectSkillDir", () => {
  it("replaces $SKILL_DIR with actual path", () => {
    const result = injectSkillDir(
      "Read `$SKILL_DIR/template.md` for the template.",
      "/tmp/skill-abc",
    );
    expect(result).toBe("Read `/tmp/skill-abc/template.md` for the template.");
  });

  it("replaces multiple occurrences", () => {
    const result = injectSkillDir("See $SKILL_DIR/a.md and $SKILL_DIR/b.md", "/tmp/skill-abc");
    expect(result).toBe("See /tmp/skill-abc/a.md and /tmp/skill-abc/b.md");
  });

  it("returns instructions unchanged when no $SKILL_DIR present", () => {
    const instructions = "Just do the thing.";
    const result = injectSkillDir(instructions, "/tmp/skill-abc");
    expect(result).toBe(instructions);
  });

  it("handles empty instructions", () => {
    expect(injectSkillDir("", "/tmp/dir")).toBe("");
  });
});
