import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const srcDir = dirname(fileURLToPath(import.meta.url));

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* walk(full);
    } else if (full.endsWith(".ts") && !full.endsWith(".test.ts")) {
      yield full;
    }
  }
}

describe("architecture", () => {
  // `@atlas/core` exports session-event types and reducers consumed by the
  // browser bundle (agent-playground). The bare `@atlas/hallucination` entry
  // re-exports `validate` and `createFSMOutputValidator` — which transitively
  // import `@atlas/logger` → `node:process`. Always use the
  // @atlas/hallucination/verdict` subpath here.
  it("must not import @atlas/hallucination via the bare-package entry", () => {
    const pattern = /from\s+["']@atlas\/hallucination["']/;
    const violations: string[] = [];

    for (const file of walk(srcDir)) {
      const lines = readFileSync(file, "utf-8").split("\n");
      for (const [i, line] of lines.entries()) {
        if (pattern.test(line)) {
          violations.push(`${file.slice(srcDir.length + 1)}:${i + 1}: ${line.trim()}`);
        }
      }
    }

    expect(
      violations,
      "@atlas/core code reaches the client bundle. The bare @atlas/hallucination " +
        "entry pulls @atlas/logger → node:process. " +
        "Use @atlas/hallucination/verdict for schemas/types instead.\n" +
        "Violations:\n" +
        violations.join("\n"),
    ).toHaveLength(0);
  });
});
