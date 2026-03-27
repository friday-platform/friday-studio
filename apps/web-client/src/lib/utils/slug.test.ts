import { describe, expect, it } from "vitest";
import { enforceKebabCase, generateSlug, retrySlugCollision, SlugCollisionError } from "./slug.ts";

describe("enforceKebabCase", () => {
  it("lowercases uppercase characters", () => {
    expect(enforceKebabCase("MySkill")).toBe("myskill");
  });

  it("replaces spaces with hyphens", () => {
    expect(enforceKebabCase("my skill")).toBe("my-skill");
  });

  it("strips special characters and replaces with hyphens", () => {
    expect(enforceKebabCase("my@skill!name")).toBe("my-skill-name");
  });

  it("collapses consecutive hyphens", () => {
    expect(enforceKebabCase("my---skill")).toBe("my-skill");
  });

  it("preserves trailing hyphens for live input", () => {
    expect(enforceKebabCase("my-skill-")).toBe("my-skill-");
  });

  it("preserves leading hyphens", () => {
    expect(enforceKebabCase("-my-skill")).toBe("-my-skill");
  });

  it("allows digits", () => {
    expect(enforceKebabCase("skill-v2")).toBe("skill-v2");
  });

  it("handles empty string", () => {
    expect(enforceKebabCase("")).toBe("");
  });

  it("replaces multiple consecutive special chars with single hyphen", () => {
    expect(enforceKebabCase("hello   world")).toBe("hello-world");
  });
});

describe("generateSlug", () => {
  it("strips extension and converts spaces/parens to hyphens", () => {
    expect(generateSlug("Q4 Report (Final).pdf")).toBe("q4-report-final");
  });

  it("strips extension from simple filename", () => {
    expect(generateSlug("data.csv")).toBe("data");
  });

  it("trims and collapses leading/trailing hyphens", () => {
    expect(generateSlug("---weird---name---.txt")).toBe("weird-name");
  });

  it("handles multiple dots — only strips last extension", () => {
    expect(generateSlug("my.config.file.json")).toBe("my-config-file");
  });

  it("handles unicode by replacing with hyphens", () => {
    expect(generateSlug("données-résumé.pdf")).toBe("donn-es-r-sum");
  });

  it("returns empty string for dotfiles with no stem", () => {
    expect(generateSlug(".gitignore")).toBe("");
  });

  it("returns empty string when nothing remains after stripping", () => {
    expect(generateSlug("---.txt")).toBe("");
  });

  it("handles filename with no extension", () => {
    expect(generateSlug("README")).toBe("readme");
  });

  it("collapses mixed special characters", () => {
    expect(generateSlug("hello   world!!!.md")).toBe("hello-world");
  });

  it("handles numbers in filename", () => {
    expect(generateSlug("2024-Q1-report.xlsx")).toBe("2024-q1-report");
  });
});

describe("retrySlugCollision", () => {
  it("returns immediately on first success", async () => {
    const result = await retrySlugCollision("report", (slug) =>
      Promise.resolve({ conflict: false as const, data: slug }),
    );
    expect(result).toBe("report");
  });

  it("retries with -2 suffix on first conflict", async () => {
    let callCount = 0;
    const result = await retrySlugCollision("report", (slug) => {
      callCount++;
      if (callCount === 1) return Promise.resolve({ conflict: true as const });
      return Promise.resolve({ conflict: false as const, data: slug });
    });
    expect(result).toBe("report-2");
  });

  it("increments suffix through multiple conflicts", async () => {
    let callCount = 0;
    const result = await retrySlugCollision("report", (slug) => {
      callCount++;
      if (callCount <= 3) return Promise.resolve({ conflict: true as const });
      return Promise.resolve({ conflict: false as const, data: slug });
    });
    expect(result).toBe("report-4");
    expect(callCount).toBe(4);
  });

  it("throws SlugCollisionError after 10 retries exhausted", async () => {
    await expect(
      retrySlugCollision("report", () => Promise.resolve({ conflict: true as const })),
    ).rejects.toThrow(SlugCollisionError);
  });

  it("makes exactly 11 attempts before throwing (1 base + 10 suffixed)", async () => {
    let callCount = 0;
    await expect(
      retrySlugCollision("report", () => {
        callCount++;
        return Promise.resolve({ conflict: true as const });
      }),
    ).rejects.toThrow(SlugCollisionError);
    expect(callCount).toBe(11);
  });
});
