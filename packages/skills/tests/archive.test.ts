import { Buffer } from "node:buffer";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTempDir } from "@atlas/utils/temp.server";
import { afterEach, describe, expect, it } from "vitest";
import {
  extractArchiveContents,
  extractSkillArchive,
  injectSkillDir,
  packSkillArchive,
  validateSkillReferences,
  writeSkillFiles,
} from "../src/archive.ts";

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

describe("extractArchiveContents", () => {
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

  it("extracts all files into a Record keyed by relative path", async () => {
    const dir = createTempDir();
    await mkdir(join(dir, "references"), { recursive: true });
    await writeFile(join(dir, "references", "guide.md"), "# Guide");
    await writeFile(join(dir, "references", "format.md"), "# Format");

    const archive = await packSkillArchive(dir);
    const contents = await extractArchiveContents(new Uint8Array(archive));

    expect(contents["references/guide.md"]).toBe("# Guide");
    expect(contents["references/format.md"]).toBe("# Format");
  });

  it("skips macOS resource fork files", async () => {
    const dir = createTempDir();
    await writeFile(join(dir, "real.md"), "content");
    await writeFile(join(dir, "._real.md"), "resource fork junk");

    const archive = await packSkillArchive(dir);
    const contents = await extractArchiveContents(new Uint8Array(archive));

    expect(contents["real.md"]).toBe("content");
    expect(contents["._real.md"]).toBeUndefined();
  });

  it("skips binary files that fail UTF-8 decoding", async () => {
    const dir = createTempDir();
    await mkdir(join(dir, "references"), { recursive: true });
    await mkdir(join(dir, "assets"), { recursive: true });
    await writeFile(join(dir, "references", "guide.md"), "# Guide");
    // Write binary data (PNG magic bytes) that is not valid UTF-8
    await writeFile(
      join(dir, "assets", "diagram.png"),
      Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
        0x52,
      ]),
    );

    const archive = await packSkillArchive(dir);
    const contents = await extractArchiveContents(new Uint8Array(archive));

    expect(contents["references/guide.md"]).toBe("# Guide");
    expect(contents["assets/diagram.png"]).toBeUndefined();
  });
});

describe("validateSkillReferences", () => {
  it("returns empty array when all links resolve", () => {
    const instructions = `
# My Skill

See [the guide](references/guide.md) for details.
Also check [format](references/format.md).
`;
    const archiveFiles = ["references/guide.md", "references/format.md"];
    const deadLinks = validateSkillReferences(instructions, archiveFiles);
    expect(deadLinks).toEqual([]);
  });

  it("detects dead links for missing files", () => {
    const instructions = `
# My Skill

See [the guide](references/guide.md) for details.
Also check [missing](references/does-not-exist.md).
`;
    const archiveFiles = ["references/guide.md"];
    const deadLinks = validateSkillReferences(instructions, archiveFiles);
    expect(deadLinks).toEqual(["references/does-not-exist.md"]);
  });

  it("ignores all protocol schemes, anchors, and special URIs", () => {
    const instructions = `
See [docs](https://example.com/docs) and [section](#intro).
Email [us](mailto:help@example.com).
Data [img](data:image/png;base64,abc123).
FTP [file](ftp://server/file.txt).
Also [local file](references/real.md).
`;
    const archiveFiles = ["references/real.md"];
    const deadLinks = validateSkillReferences(instructions, archiveFiles);
    expect(deadLinks).toEqual([]);
  });

  it("strips $SKILL_DIR/ prefix before checking", () => {
    const instructions = `
Load [$SKILL_DIR/references/criteria.md](references/criteria.md) for review criteria.
`;
    const archiveFiles = ["references/criteria.md"];
    const deadLinks = validateSkillReferences(instructions, archiveFiles);
    expect(deadLinks).toEqual([]);
  });

  it("strips fragment anchors from file links before checking", () => {
    const instructions = `See [section](references/guide.md#usage) for details.`;
    const archiveFiles = ["references/guide.md"];
    const deadLinks = validateSkillReferences(instructions, archiveFiles);
    expect(deadLinks).toEqual([]);
  });

  it("strips ./ prefix from relative links before checking", () => {
    const instructions = `See [guide](./references/guide.md) for details.`;
    const archiveFiles = ["references/guide.md"];
    const deadLinks = validateSkillReferences(instructions, archiveFiles);
    expect(deadLinks).toEqual([]);
  });

  it("returns empty array when instructions have no links", () => {
    const instructions = "Just do the review. No links here.";
    const deadLinks = validateSkillReferences(instructions, []);
    expect(deadLinks).toEqual([]);
  });

  it("deduplicates repeated dead links", () => {
    const instructions = `
See [guide](references/missing.md) and [also guide](references/missing.md).
`;
    const deadLinks = validateSkillReferences(instructions, []);
    expect(deadLinks).toEqual(["references/missing.md"]);
  });

  it("handles links inside markdown tables", () => {
    const instructions = `
| Activity | Reference |
|----------|-----------|
| Review code | [criteria](references/review-criteria.md) |
| Format output | [format](references/output-format.md) |
`;
    const archiveFiles = ["references/review-criteria.md"];
    const deadLinks = validateSkillReferences(instructions, archiveFiles);
    expect(deadLinks).toEqual(["references/output-format.md"]);
  });

  it("detects dead image references", () => {
    const instructions = `
See ![diagram](references/diagram.png) and [guide](references/guide.md).
`;
    const archiveFiles = ["references/guide.md"];
    const deadLinks = validateSkillReferences(instructions, archiveFiles);
    expect(deadLinks).toEqual(["references/diagram.png"]);
  });
});

describe("writeSkillFiles", () => {
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

  it("writes files and creates nested directories", async () => {
    const dir = createTempDir();
    await writeSkillFiles(dir, [
      { path: "README.md", content: "# Hello" },
      { path: "scripts/build.sh", content: "#!/bin/sh\necho hi" },
    ]);

    expect(await readFile(join(dir, "README.md"), "utf-8")).toBe("# Hello");
    expect(await readFile(join(dir, "scripts", "build.sh"), "utf-8")).toBe("#!/bin/sh\necho hi");
  });

  it("rejects paths containing ..", async () => {
    const dir = createTempDir();
    await expect(writeSkillFiles(dir, [{ path: "../etc/passwd", content: "bad" }])).rejects.toThrow(
      "Invalid file path: ../etc/passwd",
    );
  });

  it("rejects absolute paths", async () => {
    const dir = createTempDir();
    await expect(writeSkillFiles(dir, [{ path: "/etc/passwd", content: "bad" }])).rejects.toThrow(
      "Invalid file path: /etc/passwd",
    );
  });

  it("rejects SKILL.md by default", async () => {
    const dir = createTempDir();
    await expect(writeSkillFiles(dir, [{ path: "SKILL.md", content: "bad" }])).rejects.toThrow(
      "SKILL.md is reserved for the canonical skill instructions",
    );
  });

  it("rejects SKILL.md after normalizing current-directory segments", async () => {
    const dir = createTempDir();
    await expect(writeSkillFiles(dir, [{ path: "././SKILL.md", content: "bad" }])).rejects.toThrow(
      "SKILL.md is reserved for the canonical skill instructions",
    );
  });

  it("allows SKILL.md when opted in", async () => {
    const dir = createTempDir();
    await writeSkillFiles(dir, [{ path: "SKILL.md", content: "# Skill" }], { allowSkillMd: true });
    expect(await readFile(join(dir, "SKILL.md"), "utf-8")).toBe("# Skill");
  });

  it("rejects paths that escape the base directory via ..", async () => {
    const dir = createTempDir();
    await expect(
      writeSkillFiles(dir, [{ path: "foo/../../etc/passwd", content: "bad" }]),
    ).rejects.toThrow("Invalid file path: foo/../../etc/passwd");
  });

  it("strips leading ./ before writing", async () => {
    const dir = createTempDir();
    await writeSkillFiles(dir, [{ path: "./guide.md", content: "# Guide" }]);
    expect(await readFile(join(dir, "guide.md"), "utf-8")).toBe("# Guide");
  });
});
