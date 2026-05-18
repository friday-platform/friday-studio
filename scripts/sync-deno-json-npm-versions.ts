#!/usr/bin/env -S deno run --allow-read --allow-write
// Syncs `npm:<name>@<version>` pins in every `deno.json` to whatever version
// the workspace's `package.json` files declare for the same package.
//
// Dependabot updates `package.json` (and `deno.lock` via the
// `dependabot-lockfile.yml` workflow), but it can't touch `deno.json`. Without
// this sync, a group bump like the `hono` group leaves `deno.json` pinned to
// the old version and Deno's typechecker sees two copies of the same package —
// producing dual-package-hazard errors (e.g. `Property '[GET_MATCH_RESULT]'
// missing` between hono@4.12.18 and hono@4.12.19).
//
// Strategy:
//   1. Walk every `package.json` and collect `name -> highest-pinned-version`.
//   2. Walk every `deno.json`/`deno.jsonc`. For each `"npm:<name>@<v>..."`
//      entry, if `<name>` is known and `<v>` differs, rewrite it. The version
//      prefix (`^`, `~`, exact) is preserved from the existing `deno.json`
//      entry so we don't accidentally tighten or loosen Deno's resolution.

import { walk } from "jsr:@std/fs@^1.0.13/walk";
import { greaterThan, parseRange, parse as parseSemver, satisfies } from "jsr:@std/semver@^1.0.0";
import { z } from "npm:zod@^4.4.3";

const ROOT = new URL("..", import.meta.url).pathname;
// Match skipped dirs by repo-relative path so the script also works when the
// repo lives under a `.claude/worktrees/<branch>/` path during local testing.
const SKIP_REL = /(^|\/)(node_modules|\.svelte-kit|dist|build|\.claude)(\/|$)/;

function isSkipped(absPath: string): boolean {
  const rel = absPath.startsWith(ROOT) ? absPath.slice(ROOT.length) : absPath;
  return SKIP_REL.test(rel);
}

const PackageJsonSchema = z
  .object({
    dependencies: z.record(z.string(), z.string()).optional(),
    devDependencies: z.record(z.string(), z.string()).optional(),
    peerDependencies: z.record(z.string(), z.string()).optional(),
  })
  .loose();

function stripRange(v: string): string {
  return v.replace(/^[~^>=<\s]+/, "").trim();
}

function rangePrefix(v: string): string {
  return v.match(/^[~^]/)?.[0] ?? "";
}

async function collectWorkspaceVersions(): Promise<Map<string, string>> {
  const versions = new Map<string, string>();
  for await (const entry of walk(ROOT, { match: [/package\.json$/] })) {
    if (isSkipped(entry.path)) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(await Deno.readTextFile(entry.path));
    } catch {
      continue;
    }
    const parsed = PackageJsonSchema.safeParse(raw);
    if (!parsed.success) continue;
    const pkg = parsed.data;
    for (const deps of [pkg.dependencies, pkg.devDependencies, pkg.peerDependencies]) {
      if (!deps) continue;
      for (const [name, declared] of Object.entries(deps)) {
        const cleaned = stripRange(declared);
        // Skip git/file/workspace references — not real semvers.
        if (!/^\d/.test(cleaned)) continue;
        const existing = versions.get(name);
        if (!existing) {
          versions.set(name, cleaned);
          continue;
        }
        try {
          if (greaterThan(parseSemver(cleaned), parseSemver(existing))) {
            versions.set(name, cleaned);
          }
        } catch {
          // ignore unparseable versions
        }
      }
    }
  }
  return versions;
}

function rewriteDenoJson(content: string, versions: Map<string, string>): string | null {
  // "npm:<name>@<version>[/subpath]" — name may be scoped (@scope/pkg).
  const re = /"npm:((?:@[^/"@]+\/)?[^@/"][^@/"]*)@([^/"]+)(\/[^"]*)?"/g;
  let changed = false;
  const next = content.replace(re, (match, name: string, version: string, subpath = "") => {
    const target = versions.get(name);
    if (!target) return match;
    // Only rewrite when the existing deno.json pin can't resolve to the
    // package.json version — i.e. the dual-package hazard is real. A caret
    // pin like `^6.1.3` that already covers `6.2.3` is left alone so we don't
    // generate churn unrelated to the dependabot bump that triggered the run.
    try {
      const range = parseRange(version);
      if (satisfies(parseSemver(target), range)) return match;
    } catch {
      // Unparseable range — fall through to a simple string-equality bump.
    }
    const newVersion = rangePrefix(version) + target;
    if (newVersion === version) return match;
    changed = true;
    return `"npm:${name}@${newVersion}${subpath}"`;
  });
  return changed ? next : null;
}

async function main() {
  const versions = await collectWorkspaceVersions();
  let updated = 0;
  for await (const entry of walk(ROOT, { match: [/deno\.jsonc?$/] })) {
    if (isSkipped(entry.path)) continue;
    const original = await Deno.readTextFile(entry.path);
    const next = rewriteDenoJson(original, versions);
    if (next !== null) {
      await Deno.writeTextFile(entry.path, next);
      console.log(`updated: ${entry.path.replace(ROOT, "")}`);
      updated++;
    }
  }
  console.log(`Synced ${updated} deno.json file(s).`);
}

if (import.meta.main) {
  await main();
}
