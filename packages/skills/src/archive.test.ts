import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTempDir } from "@atlas/utils/temp.server";
import { describe, expect, it } from "vitest";
import { extractArchiveContents, packExportArchive, packSkillArchive } from "./archive.ts";
import { parseSkillMd } from "./skill-md-parser.ts";

describe("packExportArchive", () => {
  it("packs a SKILL.md from frontmatter + body when no archive is provided", async () => {
    const frontmatter = {
      name: "processing-pdfs",
      description: "Extracts text from PDFs. Use when working with PDFs.",
    };
    const instructions = "# Processing PDFs\n\nUse pdfplumber.\n";

    const result = await packExportArchive({ instructions, frontmatter, archive: null });

    const contents = await extractArchiveContents(result);
    const skillMd = contents["SKILL.md"];
    expect(skillMd).toBeDefined();

    const parsed = parseSkillMd(skillMd as string);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.data.frontmatter).toMatchObject(frontmatter);
    expect(parsed.data.instructions).toBe(instructions.trim());
  });

  it("preserves bundled reference files alongside SKILL.md", async () => {
    const refDir = makeTempDir({ prefix: "atlas-export-test-refs-" });
    const refContent = "# Foo reference\n\nDetails here.\n";
    try {
      await mkdir(join(refDir, "references"), { recursive: true });
      await writeFile(join(refDir, "references", "foo.md"), refContent);
      const inputArchive = await packSkillArchive(refDir);

      const result = await packExportArchive({
        instructions: "# Skill\n\nUses [foo](references/foo.md).\n",
        frontmatter: {
          name: "with-refs",
          description: "A skill with references. Use when you need foo.",
        },
        archive: inputArchive,
      });

      const contents = await extractArchiveContents(result);
      expect(contents["SKILL.md"]).toContain("with-refs");
      expect(contents["references/foo.md"]).toBe(refContent);
    } finally {
      await rm(refDir, { recursive: true, force: true });
    }
  });
});
