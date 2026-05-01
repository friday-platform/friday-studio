#!/usr/bin/env -S deno run -A
//
// sync-sdk-skill — re-vendors writing-friday-python-agents/ from
// friday-platform/agent-sdk at the version pinned in
// tools/friday-launcher/paths.go (`bundledAgentSDKVersion`).
//
// Run after bumping the SDK version. Idempotent — safe to re-run.
//
// CI also invokes this in --check mode: fails if the vendored content
// differs from upstream at the pinned tag, so a forgotten re-vendor
// step blocks the merge instead of shipping stale skill content.
//
// Usage:
//   deno run -A scripts/sync-sdk-skill.ts            # write
//   deno run -A scripts/sync-sdk-skill.ts --check    # CI mode (no write)
//
// Why fetch raw from GitHub rather than extract from the PyPI wheel:
//   The skill files live under packages/python/skills/ in the SDK
//   repo and are not packaged into the published wheel (the wheel
//   contains only the importable Python module). Pulling from a tag
//   ref of the upstream repo is the only deterministic source.

import { dirname, fromFileUrl, join, resolve } from "jsr:@std/path@^1";

const REPO_ROOT = resolve(dirname(fromFileUrl(import.meta.url)), "..");
const VENDORED_DIR = join(REPO_ROOT, "packages/system/skills/writing-friday-python-agents");
const LAUNCHER_PATHS_GO = join(REPO_ROOT, "tools/friday-launcher/paths.go");
const SDK_REPO = "friday-platform/agent-sdk";
const SDK_SKILL_PATH = "packages/python/skills/writing-friday-python-agents";

// The skill tree we vendor. Exhaustive — keep in sync with the upstream
// directory layout. If the SDK adds new reference files, surface them
// here explicitly rather than crawling, so a new file going stale is
// loud (CI fails) rather than quiet (silently missing).
const SKILL_FILES = [
  "SKILL.md",
  "references/api.md",
  "references/constraints.md",
  "references/examples.md",
] as const;

// Constraint to remember when bumping upstream: friday-studio's skill
// parser (packages/config/src/skills.ts) rejects `<` and `>` in
// descriptions to prevent XML injection. Keep the upstream description
// angle-bracket-free.

interface CliOptions {
  check: boolean;
}

function parseArgs(args: string[]): CliOptions {
  return { check: args.includes("--check") };
}

async function readPinnedSdkVersion(): Promise<string> {
  const content = await Deno.readTextFile(LAUNCHER_PATHS_GO);
  const match = content.match(/^const bundledAgentSDKVersion\s*=\s*"([^"]+)"/m);
  if (!match) {
    throw new Error(
      `Could not find bundledAgentSDKVersion in ${LAUNCHER_PATHS_GO}. ` +
        "Re-check the constant name — it's the source of truth for the pinned SDK version.",
    );
  }
  return match[1];
}

async function fetchUpstream(version: string, fileRelPath: string): Promise<string> {
  const tag = `v${version}`;
  const url = `https://raw.githubusercontent.com/${SDK_REPO}/${tag}/${SDK_SKILL_PATH}/${fileRelPath}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Fetching ${url} failed: ${response.status} ${response.statusText}. ` +
        `Likely the tag ${tag} doesn't exist or the file moved upstream.`,
    );
  }
  return await response.text();
}

/**
 * Splice vendored-from / vendored-path / vendored-version into the
 * upstream frontmatter and prepend a "don't edit in place" comment.
 * Description, body, and reference files are passthrough-verbatim —
 * upstream is the sole source of truth for content.
 */
function transformSkillMd(upstream: string, version: string, sha: string): string {
  const FRONTMATTER_DELIM = "\n---\n";
  const frontmatterEnd = upstream.indexOf(FRONTMATTER_DELIM, 4);
  if (frontmatterEnd === -1) {
    throw new Error("Upstream SKILL.md is missing frontmatter — refusing to vendor.");
  }
  const upstreamFrontmatter = upstream.slice(0, frontmatterEnd);
  const body = upstream.slice(frontmatterEnd + FRONTMATTER_DELIM.length).trimStart();

  return [
    upstreamFrontmatter,
    `vendored-from: ${SDK_REPO}@${sha}`,
    `vendored-path: ${SDK_SKILL_PATH}/`,
    `vendored-version: ${version}`,
    "---",
    "",
    "<!--",
    "  This skill is vendored from the friday-agent-sdk repo. Edits should land",
    "  upstream first; scripts/sync-sdk-skill.ts re-vendors for the pinned",
    "  FRIDAY_AGENT_SDK_VERSION (see tools/friday-launcher/paths.go).",
    "-->",
    "",
    body,
  ].join("\n");
}

async function resolveTagSha(version: string): Promise<string> {
  // GitHub's tag reference API. Lightweight (no clone) and the response
  // is the exact commit SHA the tag points at.
  const tag = `v${version}`;
  const url = `https://api.github.com/repos/${SDK_REPO}/git/refs/tags/${tag}`;
  const response = await fetch(url, { headers: { Accept: "application/vnd.github+json" } });
  if (!response.ok) {
    throw new Error(`Resolving tag ${tag} failed: ${response.status} ${response.statusText}`);
  }
  const json = (await response.json()) as { object: { sha: string; type: string } };
  // Annotated tags wrap a commit; lightweight tags point at the commit
  // directly. The fields differ but both expose `object.sha`. For our
  // pin-recording purposes either is fine.
  return json.object.sha;
}

async function writeFile(path: string, content: string): Promise<void> {
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, content);
}

async function main() {
  const opts = parseArgs(Deno.args);
  const version = await readPinnedSdkVersion();
  const sha = await resolveTagSha(version);
  console.log(`→ Vendoring writing-friday-python-agents from ${SDK_REPO}@${sha} (v${version})`);

  let drift = false;

  for (const fileRelPath of SKILL_FILES) {
    const upstream = await fetchUpstream(version, fileRelPath);
    const local = fileRelPath === "SKILL.md" ? transformSkillMd(upstream, version, sha) : upstream;
    const localPath = join(VENDORED_DIR, fileRelPath);

    let existing: string | null = null;
    try {
      existing = await Deno.readTextFile(localPath);
    } catch {
      existing = null;
    }

    if (existing === local) {
      console.log(`  ✓ ${fileRelPath} — in sync`);
      continue;
    }

    if (opts.check) {
      console.error(`  ✗ ${fileRelPath} — drift detected`);
      drift = true;
      continue;
    }

    await writeFile(localPath, local);
    console.log(`  ↻ ${fileRelPath} — updated`);
  }

  if (opts.check && drift) {
    console.error("");
    console.error("Vendored skill is out of sync with upstream. Re-run without --check to update:");
    console.error("  deno run -A scripts/sync-sdk-skill.ts");
    Deno.exit(1);
  }

  console.log("✓ Done.");
}

if (import.meta.main) {
  await main();
}
