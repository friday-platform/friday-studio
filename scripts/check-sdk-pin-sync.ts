#!/usr/bin/env -S deno run --allow-read
//
// check-sdk-pin-sync — fails if the friday-agent-sdk version pin drifts
// across the three sites that must agree:
//
//   - tools/friday-launcher/paths.go (bundledAgentSDKVersion)
//   - Dockerfile (ENV FRIDAY_AGENT_SDK_VERSION=)
//   - apps/studio-installer/src-tauri/src/commands/prewarm_agent_sdk.rs
//     (BUNDLED_AGENT_SDK_VERSION)
//
// Run in CI on every PR (.github/workflows/sdk-skill-drift.yml) and
// in lint-staged when any of the three pin files is staged.

import { dirname, fromFileUrl, join, resolve } from "jsr:@std/path@^1";

const REPO_ROOT = resolve(dirname(fromFileUrl(import.meta.url)), "..");

const SITES = [
  {
    name: "launcher (paths.go)",
    path: join(REPO_ROOT, "tools/friday-launcher/paths.go"),
    pattern: /^const bundledAgentSDKVersion\s*=\s*"([^"]+)"/m,
  },
  {
    name: "Dockerfile",
    path: join(REPO_ROOT, "Dockerfile"),
    pattern: /^ENV FRIDAY_AGENT_SDK_VERSION=([^\s\\]+)/m,
  },
  {
    name: "installer (prewarm_agent_sdk.rs)",
    path: join(REPO_ROOT, "apps/studio-installer/src-tauri/src/commands/prewarm_agent_sdk.rs"),
    pattern: /const BUNDLED_AGENT_SDK_VERSION:\s*&str\s*=\s*"([^"]+)"/,
  },
] as const;

const versions = await Promise.all(
  SITES.map(async (s) => {
    const content = await Deno.readTextFile(s.path);
    const m = content.match(s.pattern);
    if (!m) throw new Error(`could not find pin in ${s.name} (${s.path})`);
    return { site: s.name, version: m[1]! };
  }),
);

const unique = new Set(versions.map((v) => v.version));
if (unique.size === 1) {
  console.log(`✓ All sites pinned to ${[...unique][0]}`);
  Deno.exit(0);
}

console.error("✗ SDK version pin drift detected:");
for (const v of versions) console.error(`  ${v.site}: ${v.version}`);
Deno.exit(1);
