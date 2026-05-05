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

  it("does not double-write frontmatter when instructions already contain a frontmatter block", async () => {
    // Reproduces the JSON-publish path where the body was stored verbatim
    // with frontmatter still embedded; the `frontmatter` column is empty.
    const instructionsWithEmbeddedFm =
      "---\nname: workspace-sparring\ndescription: Acts as a sparring partner. Use when designing workspaces.\n---\n\n# Workspace Sparring\n\nBody here.\n";

    const result = await packExportArchive({
      instructions: instructionsWithEmbeddedFm,
      frontmatter: {},
      archive: null,
    });

    const contents = await extractArchiveContents(result);
    const skillMd = contents["SKILL.md"] as string;

    // The output must have exactly one frontmatter block, not two.
    const frontmatterDelimiters = skillMd.match(/^---$/gm);
    expect(frontmatterDelimiters?.length ?? 0).toBe(2);

    const parsed = parseSkillMd(skillMd);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.data.frontmatter.name).toBe("workspace-sparring");
    expect(parsed.data.frontmatter.description).toContain("sparring partner");
  });

  it("splits embedded frontmatter even when it lacks a description (legacy row shape)", async () => {
    // Legacy rows from before the JSON-publish split fix have an embedded
    // `---...---` block in `instructions` and an empty `frontmatter` column.
    // The strict parser rejects these (no `description` key), so the export
    // path used to fall back to raw input and emit two frontmatter blocks.
    const instructionsWithLegacyFm =
      "---\nname: legacy-skill\n---\n\n# Legacy Skill\n\nBody here.\n";

    const result = await packExportArchive({
      instructions: instructionsWithLegacyFm,
      frontmatter: {},
      archive: null,
    });

    const contents = await extractArchiveContents(result);
    const skillMd = contents["SKILL.md"] as string;

    // Exactly one frontmatter block: 2 `---` delimiters, not 4.
    const frontmatterDelimiters = skillMd.match(/^---$/gm);
    expect(frontmatterDelimiters?.length ?? 0).toBe(2);

    // Body must not start with a frontmatter delimiter.
    const body = skillMd.split(/^---$/gm).slice(2).join("---").trimStart();
    expect(body.startsWith("---")).toBe(false);
    expect(body).toContain("# Legacy Skill");
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
