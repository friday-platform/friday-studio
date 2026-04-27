import { describe, expect, it } from "vitest";
import {
  BODY_WARN_LINES,
  invalidateLintCache,
  type LintInput,
  lintCache,
  lintSkill,
} from "./skill-linter.ts";

function mkInput(overrides: Partial<LintInput> = {}): LintInput {
  return {
    name: "processing-pdfs",
    frontmatter: {
      description:
        "Extracts text from PDF files. Use when working with PDFs or when the user mentions forms.",
    },
    instructions: "# Processing PDFs\n\nUse pdfplumber.\n",
    ...overrides,
  };
}

describe("lintSkill — frontmatter", () => {
  it("passes a well-formed skill", () => {
    const result = lintSkill(mkInput(), "publish");
    expect(result.errors).toEqual([]);
  });

  it("warns when description is missing", () => {
    const result = lintSkill(mkInput({ frontmatter: {} }), "load");
    expect(result.warnings.map((w) => w.rule)).toContain("description-missing");
    expect(result.errors.map((e) => e.rule)).not.toContain("description-missing");
  });

  it("errors when description exceeds 1024 chars", () => {
    const result = lintSkill(mkInput({ frontmatter: { description: "x".repeat(1025) } }), "load");
    expect(result.errors.map((e) => e.rule)).toContain("description-length");
  });

  it("warns on first-person description", () => {
    const result = lintSkill(
      mkInput({ frontmatter: { description: "I can help with PDFs." } }),
      "load",
    );
    expect(result.warnings.map((w) => w.rule)).toContain("description-person");
  });

  it("info-flags description missing a 'Use when' trigger", () => {
    const result = lintSkill(
      mkInput({ frontmatter: { description: "Extracts text from PDF files." } }),
      "load",
    );
    const trigger = result.warnings.find((w) => w.rule === "description-trigger");
    expect(trigger?.severity).toEqual("info");
  });

  it("errors on reserved substring in name", () => {
    const result = lintSkill(mkInput({ name: "claude-helper" }), "load");
    expect(result.errors.map((e) => e.rule)).toContain("name-reserved");
  });
});

describe("lintSkill — body budgets", () => {
  it("warns when body exceeds the line threshold", () => {
    const body = `# Title\n${"word\n".repeat(BODY_WARN_LINES + 50)}`;
    const result = lintSkill(mkInput({ instructions: body }), "load");
    expect(result.warnings.map((w) => w.rule)).toContain("body-lines");
  });

  it("errors when body exceeds the hard line ceiling", () => {
    const body = `# Title\n${"word\n".repeat(900)}`;
    const result = lintSkill(mkInput({ instructions: body }), "load");
    expect(result.errors.map((e) => e.rule)).toContain("body-lines");
  });
});

describe("lintSkill — style checks", () => {
  it("ignores time-sensitive prose that only appears inside a code block", () => {
    const body = "Example:\n\n```\nBefore August 2025, use the old API.\n```\n";
    const result = lintSkill(mkInput({ instructions: body }), "load");
    expect(result.warnings.map((w) => w.rule)).not.toContain("time-sensitive");
  });

  it("warns on time-sensitive prose outside code blocks", () => {
    const body = "Before August 2025, use the old API.\n";
    const result = lintSkill(mkInput({ instructions: body }), "load");
    expect(result.warnings.map((w) => w.rule)).toContain("time-sensitive");
  });

  it("errors on Windows-style paths outside code blocks", () => {
    const body = "Open scripts\\helper.py to see the code.\n";
    const result = lintSkill(mkInput({ instructions: body }), "load");
    expect(result.errors.map((e) => e.rule)).toContain("path-style");
  });
});

describe("lintSkill — allowed-tools", () => {
  it("warns on unknown tool names when a registry is provided", () => {
    const result = lintSkill(
      mkInput({
        frontmatter: {
          description: "Extracts text from PDFs. Use when working with PDFs.",
          "allowed-tools": "Read, ReallyNotAThing",
        },
        knownTools: new Set(["Read", "Bash", "Edit"]),
      }),
      "load",
    );
    expect(result.warnings.find((w) => w.rule === "allowed-tools-unknown")).toBeDefined();
  });

  it("normalises Bash(rm:*) to Bash before matching", () => {
    const result = lintSkill(
      mkInput({
        frontmatter: {
          description: "Extracts text from PDFs. Use when working with PDFs.",
          "allowed-tools": "Bash(rm:*), Read",
        },
        knownTools: new Set(["Read", "Bash"]),
      }),
      "load",
    );
    expect(result.warnings.find((w) => w.rule === "allowed-tools-unknown")).toBeUndefined();
  });

  it("skips the check when knownTools is null (forward-compat)", () => {
    const result = lintSkill(
      mkInput({
        frontmatter: {
          description: "Extracts text. Use when working with PDFs.",
          "allowed-tools": "NewShinyTool",
        },
        knownTools: null,
      }),
      "load",
    );
    expect(result.warnings.find((w) => w.rule === "allowed-tools-unknown")).toBeUndefined();
  });
});

describe("lintSkill — publish-mode reference checks", () => {
  it("errors when SKILL.md references a missing archive file", () => {
    const result = lintSkill(
      mkInput({
        instructions: "# x\n\nSee [guide](references/missing.md).\n",
        archiveFiles: ["references/other.md"],
      }),
      "publish",
    );
    expect(result.errors.map((e) => e.rule)).toContain("reference-broken");
  });

  it("warns on depth-2 reference chains", () => {
    const result = lintSkill(
      mkInput({
        instructions: "# x\n\nSee [a](references/a.md).\n",
        archiveFiles: ["references/a.md", "references/b.md"],
        archiveContents: {
          "references/a.md": "See [b](references/b.md) for more.",
          "references/b.md": "leaf content",
        },
      }),
      "publish",
    );
    expect(result.warnings.map((w) => w.rule)).toContain("reference-depth");
  });

  it("warns when a reference file over 100 lines lacks a Contents TOC", () => {
    const longRef = Array.from({ length: 120 }, (_, i) => `line ${String(i)}`).join("\n");
    const result = lintSkill(
      mkInput({
        instructions: "# x\n\nSee [long](references/long.md).\n",
        archiveFiles: ["references/long.md"],
        archiveContents: { "references/long.md": longRef },
      }),
      "publish",
    );
    expect(result.warnings.map((w) => w.rule)).toContain("reference-toc");
  });
});

describe("lintCache", () => {
  it("caches and invalidates by skillId prefix", () => {
    lintCache.clear();
    lintCache.set("sk-abc", 1, { warnings: [], errors: [] });
    lintCache.set("sk-abc", 2, { warnings: [], errors: [] });
    lintCache.set("sk-xyz", 1, { warnings: [], errors: [] });
    expect(lintCache.size()).toEqual(3);
    invalidateLintCache("sk-abc");
    expect(lintCache.size()).toEqual(1);
    expect(lintCache.get("sk-xyz", 1)).toBeDefined();
  });
});
