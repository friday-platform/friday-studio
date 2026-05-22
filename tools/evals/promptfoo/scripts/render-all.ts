#!/usr/bin/env -S deno run -A
/**
 * Runs every suite's `render.ts` so each suite's `tests.generated.yaml`
 * is freshly produced from the real prompt-building function.
 *
 * Used by:  `deno task evals:render-promptfoo`
 *
 * Discovers any `suites/*\/render.ts`, imports them in parallel via
 * `Promise.allSettled` so a failure in one renderer doesn't mask others.
 * Exits non-zero if any renderer's structural pre-check throws.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const suitesDir = join(here, "..", "suites");

const entries: string[] = [];
for await (const entry of Deno.readDir(suitesDir)) {
  if (!entry.isDirectory) continue;
  const renderPath = join(suitesDir, entry.name, "render.ts");
  try {
    await Deno.stat(renderPath);
    entries.push(renderPath);
  } catch {
    // suite has no renderer — that's fine, e.g., progress-line has none.
  }
}

if (entries.length === 0) {
  console.log("no renderers found under suites/*/render.ts");
  Deno.exit(0);
}

for (const path of entries) console.log(`▶ ${path}`);

// Dynamic import runs each script's top-level body once. Renderers are
// independent (different output paths) so parallel execution is safe and
// `allSettled` lets us report every failure rather than aborting on the first.
const results = await Promise.allSettled(entries.map((path) => import(`file://${path}`)));

let failed = 0;
results.forEach((result, i) => {
  if (result.status === "rejected") {
    failed += 1;
    console.error(`✗ ${entries[i]}`);
    console.error(result.reason);
  }
});

if (failed > 0) {
  console.error(`\n${failed} renderer(s) failed.`);
  Deno.exit(1);
}
console.log(`\n✓ rendered ${entries.length} suite(s).`);
