import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(pkgDir, "src");

describe("architecture", () => {
  it("agent-sdk must not import any @atlas/* package (leaf node enforcement)", () => {
    const allFiles = readdirSync(srcDir, { recursive: true, encoding: "utf-8" });
    const sourceFiles = allFiles.filter(
      (f: string) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
    );

    const importPattern = /from\s+["']@atlas\/(?!agent-sdk["'/])/;
    const violations: string[] = [];

    for (const file of sourceFiles) {
      const filePath = join(srcDir, file);
      const content = readFileSync(filePath, "utf-8");
      const lines = content.split("\n");

      for (const [i, line] of lines.entries()) {
        if (importPattern.test(line)) {
          violations.push(`${file}:${i + 1}: ${line.trim()}`);
        }
      }
    }

    expect(
      violations,
      "@atlas/agent-sdk is a leaf node — it must not import from other @atlas/* packages. " +
        "Move shared types/utilities into the SDK or use dependency inversion.\n" +
        "Violations:\n" +
        violations.join("\n"),
    ).toHaveLength(0);
  });

  it("package.json must not declare any @atlas/* dependency", () => {
    const raw: unknown = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf-8"));
    const pkg = z
      .object({
        dependencies: z.record(z.string(), z.string()).optional(),
        devDependencies: z.record(z.string(), z.string()).optional(),
      })
      .parse(raw);
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    const atlasDeps = Object.keys(allDeps).filter((d) => d.startsWith("@atlas/"));

    expect(
      atlasDeps,
      `@atlas/agent-sdk package.json must not depend on other @atlas/* packages.\n` +
        `Found: ${atlasDeps.join(", ")}`,
    ).toHaveLength(0);
  });
});
