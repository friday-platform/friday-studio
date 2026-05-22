#!/usr/bin/env -S deno run -A
/**
 * Runs every suite's `render.ts` so each suite's `tests.generated.yaml`
 * is freshly produced from the real prompt-building function.
 *
 * Used by:  `deno task evals:render-promptfoo`
 *
 * Discovers any `suites/*\/render.ts`, executes it inline (so a failed
 * structural pre-check inside a renderer aborts the whole regeneration
 * with a non-zero exit). Runs suites sequentially — the cost is one
 * function call per case, not API calls; parallelism would only speed up
 * import resolution.
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

let failed = 0;
for (const path of entries) {
  console.log(`▶ ${path}`);
  try {
    // Dynamic import runs the script top-level body once. Each renderer is
    // idempotent — re-importing in the same process would be a cache hit, but
    // we expect this script to run as a one-shot, so we don't worry about it.
    await import(`file://${path}`);
  } catch (e) {
    failed += 1;
    console.error(`✗ ${path}`);
    console.error(e);
  }
}

if (failed > 0) {
  console.error(`\n${failed} renderer(s) failed.`);
  Deno.exit(1);
}
console.log(`\n✓ rendered ${entries.length} suite(s).`);
