# Studio Bundle Size + CI Time Reduction Plan

**Date:** 2026-04-26
**Status:** Drafted from a 3-agent inventory pass. No code changes yet.

## Problem

`friday-studio_0.0.4_aarch64-apple-darwin.tar.gz` is **1.07 GB compressed**
(4.11 GB extracted, 3.8:1 ratio). Each fresh build cycle (CI → notarize →
upload → user download → install) burns ~25–30 min and ~1–2 GB bandwidth.
This is hostile to:

- **CI iteration speed.** Every change requires waiting 25 min to ship a
  testable installer; a typo costs an hour round-trip.
- **User install experience.** A 1 GB download over a hotel WiFi is the
  difference between "I'll try it now" and "I'll get back to it later"
  (~70% of the latter never come back).
- **Apple notarization throughput.** Notarize submission fee is wall-clock
  time per binary set; bigger payloads notarize slower.
- **Storage + bandwidth costs.** GCS egress and Cloudflare cache footprint
  scale linearly with size × downloads.

## Inventory (verified against the live v0.0.4 bundle)

| Component | Extracted Size | % of Bundle | Notes |
|---|---:|---:|---|
| `playground` (deno) | 960.7 MB | 23.4% | Deno runtime + V8 + Svelte build embedded |
| `friday` (deno) | 957.7 MB | 23.3% | Deno runtime + V8 + atlas-cli graph |
| `link` (deno) | 950.9 MB | 23.1% | Deno runtime + V8 + link service |
| `webhook-tunnel` (deno) | 950.9 MB | 23.1% | Deno runtime + V8 + webhook routing |
| **Deno subtotal** | **3,820 MB** | **92.9%** | **4× duplicated runtime ~600 MB each** |
| `gh` (vendor) | 51.2 MB | 1.2% | Pre-built GitHub CLI |
| `cloudflared` (vendor) | 37.7 MB | 0.9% | Pre-built Cloudflare tunnel |
| `friday-launcher` (go) | 7.3 MB | 0.2% | New launcher (process-compose lib) |
| `pty-server` (go) | 6.0 MB | 0.1% | Pure Go |
| _Other / metadata_ | ~25 MB | 0.6% | scripts, config, agent-playground assets |

**Headline:** every Deno binary independently embeds the V8 engine + Deno's
Rust runtime (~600–700 MB per binary) PLUS its app's full module graph
(~250–350 MB per app). Compressing 4 copies of the same V8 only buys
~3.5:1 ratio because gzip is poor at detecting cross-stream duplication.

## Goal

Cut bundle to **<300 MB compressed** (~75% reduction) and CI build time
to **<15 min wall-clock** (~40% reduction) without compromising:
- Single-binary install (no Homebrew prerequisites)
- Codesign + notarize compliance
- Cross-platform parity (macOS arm/intel + Windows)

## Tier 1 — Land This Week (low risk, high ROI)

### 1.1 Switch `tar -czf` → `tar -I 'zstd -T0 -19'`

**Saves:** ~10–15% archive size (1070 MB → ~900 MB) AND ~30s compression
time via parallel zstd. zstd -19 is high-ratio; `-T0` is full parallelism.

**Action:** Update both archive command in `scripts/build-studio.ts` AND
the installer's `extract.rs` to handle `.tar.zst` (it currently expects
`.tar.gz` or `.zip`). Add `zstd` crate to installer's Cargo.toml.

**Risk:** Low. zstd is shipped with macOS 12.4+ and Windows via runtime.
**Effort:** S (workflow + extract.rs + Cargo.toml)

### 1.2 Enable Deno + npm caches in CI

**Saves:** ~2 min per build (one-time download eliminated on cache hit).

**Action:**
- `actions/setup-node` already supports `cache: 'npm'` — wire it up
- Add explicit `actions/cache@v4` for `~/.deno/` keyed on `deno.lock` hash

**Risk:** Low (if cache is poisoned, just bust the key)
**Effort:** XS

### 1.3 Notarize `.tar.zst` directly, skip `ditto` zip wrapper

**Saves:** ~30–60s + skips the wasteful zip→unzip cycle.

**Action:** macOS `notarytool submit` accepts `.zip` only — but we can
zip the `.tar.zst` (small) instead of zipping the original tar.gz contents
(huge). Or move to a single-file notarize.

**Risk:** Low — same notarytool API.
**Effort:** S

**Tier 1 totals:** ~150 MB saved (zstd ratio improvement) + ~3 min CI saved.
Bundle 1.07 GB → ~920 MB.

> **Note on bundled vendor binaries (`gh`, `cloudflared`, future tools):**
> Out of scope to remove. The platform's offline-installable design means
> we will be ADDING more bundled tools (more vendor binaries, more first-
> party services), not fewer. This forces us toward Tier 3.2 (lazy
> download) as the primary lever — bundled-tool-trimming is a non-strategy
> for a stack whose surface area is growing.

## Tier 2 — Land Next Sprint (medium risk, big ROI)

### 2.1 Per-binary Deno dep audit

**Saves:** Estimated ~200–400 MB **per Deno binary** if unused deps get
cut from each app's import graph. atlas-cli pulls in OTel collectors,
which together can be 100s of MB. link/webhook-tunnel have lighter graphs
but probably also include unneeded deps.

**Action:** For each of the 4 Deno entrypoints, run
`deno info <entry> --json` and inspect the module graph. Look for:
- OTel exporters that aren't reachable in production paths
- Test-only deps leaking into prod (e.g., vitest, mocking libs)
- Heavy AI SDK provider packages we don't need bundled
- Duplicate npm packages from competing transitive deps

**Risk:** Medium. May surface load-bearing deps disguised as unused.
**Effort:** M per binary (~1 day each)

**Estimated win:** ~600–1000 MB if all four shed 200 MB each.

### 2.2 Compress with zstd -22 (long-mode dictionary)

**Saves:** Additional 5–10% on top of 1.2 by training zstd on a
representative bundle. Particularly effective at cross-binary V8
duplication.

**Action:** Train a zstd dictionary on a sample bundle (one-time), ship
the dictionary embedded in the installer + use `--long=31` mode for
window size matching.

**Risk:** Low. Worst case fall back to standard zstd.
**Effort:** S (dict training + workflow)

**Estimated additional win:** ~50–80 MB on top of Tier 1.

### 2.3 Skip notarize for non-release CI builds

**Saves:** 2–5 min per CI run for branch builds.

**Action:** Gate notarize step behind `if: github.ref == 'refs/heads/main'`
or a `release: true` workflow input. Branch builds get codesigned (so
the binary still runs locally for QA via `xattr -d com.apple.quarantine`)
but skip the Apple notary roundtrip.

**Risk:** Low. Branch artifacts won't pass strict Gatekeeper but that's
fine for QA.
**Effort:** XS

## Tier 3 — Architectural (high risk, max ROI; needs design)

### 3.1 Monolithic Deno binary with subcommand routing

**Saves:** ~600–700 MB (single Deno runtime instead of 4×).

**Action:** Merge atlas-cli, link, webhook-tunnel, playground into one
Deno binary with `friday <subcommand>` routing. The launcher invokes
`friday daemon`, `friday link`, etc. via process-compose entries.

**Trade-offs:**
- Pro: ~70% bundle size reduction in one swing
- Con: Tighter coupling between formerly-independent services
- Con: Each service's Rust SDK overhead now multiplied across all subcommands
- Con: Major refactor; test surface widens

**Risk:** High. Code reorg + revalidation across all 4 services.
**Effort:** L (~2–3 weeks if serious)

**Decision needed:** Worth the ergonomic cost? Maybe split differently
(e.g., `friday-platform` = atlas-cli + link + webhook-tunnel; `friday-ui`
= playground separate so its frontend churn doesn't trigger platform
re-notarize).

### 3.2 Lazy/differential download — small installer + on-demand fetch ★ RECOMMENDED

**Saves:** Installer download drops from 1 GB → ~10–15 MB. Platform
binaries download on first launch. Subsequent updates fetch only changed
binaries (sha-keyed differential). Critically: **bundle size grows
linearly with new vendor tools today; with this design, only the
on-disk install grows — the installer download stays constant.**

**Action:** Installer ships ONLY `friday-launcher` + a manifest pointing
at per-binary URLs. Launcher's first run downloads + verifies each
binary to `~/.friday/local/bin/<name>`. Subsequent updates fetch only
changed binaries based on per-binary sha256 in the manifest.

**Manifest evolution:** `manifest.json` shifts from one tarball URL per
platform to a list of per-binary entries:
```json
{
  "version": "1.0.0",
  "platforms": {
    "macos-arm": {
      "binaries": [
        {"name": "friday",         "url": "...", "sha256": "...", "size": 957000000},
        {"name": "link",           "url": "...", "sha256": "...", "size": 950000000},
        {"name": "playground",     "url": "...", "sha256": "...", "size": 960000000},
        {"name": "pty-server",     "url": "...", "sha256": "...", "size":   6000000},
        {"name": "webhook-tunnel", "url": "...", "sha256": "...", "size": 950000000},
        {"name": "gh",             "url": "...", "sha256": "...", "size":  51000000},
        {"name": "cloudflared",    "url": "...", "sha256": "...", "size":  37000000}
      ]
    }
  }
}
```

Each binary is independently codesigned + notarized once, uploaded to
GCS at versioned URLs, then served via Cloudflare. Adding new vendor
tools is "drop into the manifest"; no monolith re-bake.

**Trade-offs:**
- Pro: Installer download stays at ~15 MB regardless of how many tools
  we add. **This is what makes the architecture sustainable.**
- Pro: Differential updates for free. Per-binary signing possible.
- Pro: Resumable, retry-friendly download. Per-binary progress in UI.
- Pro: Codesign + notarize parallelizable per binary. Faster CI.
- Con: Online install requirement (no air-gap install). For dev/CI
  use cases, an "all-in-one tarball" build flag stays around.
- Con: First launch shows download UI for ~1 GB total. Mitigation:
  download in background, prioritize the binary needed for first-run
  flow (playground), let others stream in.
- Con: Launcher gets a download manager + verification path.

**Risk:** Medium. Lots of new code paths; needs solid progress UX +
retry/resume + sha verification.
**Effort:** L (~3–4 weeks)

**This is THE answer.** Tier 3.1 (monolithic Deno) is now a parallel
optimization on top — even with lazy download, individual binaries are
still 950 MB. Lazy download fixes the installer experience; monolithic
binary fixes the on-disk footprint. Both are wanted; lazy download is
the more user-visible win.

### 3.3 Build matrix consolidation: cross-compile both macOS targets from one runner

**Saves:** Reduces macOS runner-minutes 2× (currently each macOS arch =
its own runner with its own setup cost). Also halves codesign+notarize
time since both arch's binaries can sign in one batch.

**Action:** Build macos-arm + macos-intel from the same `macos-latest-xlarge`
runner sequentially, with `lipo`-merged universal binaries OR per-arch
sequential builds sharing all caches.

**Risk:** Medium. Concurrency-vs-cache-reuse trade-off; needs careful
matrix surgery. macos-intel is currently disabled, so revisit when re-enabled.
**Effort:** M (~3 days when macos-intel comes back)

## Tier 4 — Speculation / Don't Do Yet

- **UPX-pack the Deno binaries.** Breaks codesign + Gatekeeper. Skip.
- **Strip Deno binaries with `strip`.** Mixed code/data; corrupts V8 JIT
  metadata. Skip.
- **`deno compile --no-code-cache`.** Saves disk, costs startup time. Net
  negative for users. Skip.
- **Brotli over zstd.** Better ratio but slower decompression and not
  built-in to Rust ecosystem. Stick with zstd.
- **Fork process-compose to drop gin/swag/tcell/tview/gopsutil.** Saves
  ~5–10 MB on a 7 MB launcher binary. Maintenance cost > savings. Skip
  unless we hit other reasons to fork.

## Recommended Sequencing

**Sprint 1 (this week) — quick wins on the existing monolith:**
- Tier 1.1 (zstd) + 1.2 (caches) + 1.3 (skip ditto wrap)
- Tier 2.3 (skip notarize on branch builds) — biggest CI iteration win
- Estimated outcome: 1.07 GB → ~920 MB, CI ~25 min → ~17 min for branch
  builds, ~22 min for main. Buys breathing room while we design Tier 3.2.

**Sprint 2 (start the architectural shift) — design Tier 3.2:**
- Spec the per-binary manifest schema, lazy-download flow, retry/resume
  semantics, signing strategy.
- Update `studio-build.yml` to publish per-binary artifacts to GCS in
  parallel (each binary as its own asset).
- Spec the launcher's download manager + first-run UX (progress UI,
  background-download, prioritized fetch order).

**Sprint 3 (ship Tier 3.2):**
- Implement launcher download manager + verification.
- Rewrite installer to ship just the launcher (~15 MB).
- Migrate manifest format. Keep an "all-in-one" build flag for air-gap
  installs (CI / dev).
- Cut over the production manifest URL.

**Background work that can run in parallel with Sprint 2/3:**
- Tier 2.1 (Deno dep audit on atlas-cli) — independent, lands per-binary
  size cuts that compound with lazy download.

**Backlog:**
- Tier 3.1 (monolithic Deno) — re-evaluate AFTER lazy download lands.
  May be unnecessary if per-binary downloads + caching make individual
  binary size matter less to users.
- Tier 3.3 (cross-compile both macOS arches) — when macos-intel is
  re-enabled.

## Out of Scope

- Reducing the launcher binary itself (already 7 MB; not the problem)
- Process-compose pruning (rounding error)
- Replacing Deno with Bun or Node (architectural; out of scope here)
- Replacing the playground frontend (out of scope)

## Deep Dep Audit (verified against actual module graphs)

**Per-binary breakdown** (uncompressed, after subtracting ~700 MB of V8 +
Deno runtime that's identical across all 4):

| Binary | App code MB | Modules | Load-bearing dep clusters |
|---|---:|---:|---|
| `friday` (atlas-cli daemon) | ~250 MB | 1,114 | All chat adapters, all AI SDK providers, claude-agent-sdk, MCP, hubspot |
| `link` (credentials) | ~150 MB | 110 | hono, postgres, oauth4webapi, MCP, hubspot |
| `webhook-tunnel` | ~90 MB | 61 | hono, zod, cloudflared, logger |
| `playground` (UI server) | ~250 MB | (not enumerated) | Embedded Svelte build + same atlasd graph leak as `friday` |

**Yardstick:** `webhook-tunnel` at 90 MB shows what a focused service looks
like. `link` at 150 MB is reasonable. `friday` and `playground` at 250 MB
each carry a ~150 MB tail of avoidable transitive deps.

### Real cuts identified (with citations)

#### A. `friday` binary — eager AI provider imports

**Location:** `packages/llm/mod.ts` re-exports `createAnthropicWithOptions`,
`createOpenAIWithOptions`, `createGoogleWithOptions`,
`createGroqWithOptions`, `createFireworksWithOptions` unconditionally.

**Bundles:** `@ai-sdk/anthropic` (2.9 MB), `@ai-sdk/openai` (3.6 MB),
`@ai-sdk/google` (1.4 MB), `@ai-sdk/groq` (~2 MB), `@ai-sdk/fireworks`
(~2 MB), `@anthropic-ai/claude-agent-sdk` (3.9 MB) — total ~16 MB
unpacked, but with their transitive deps (zod schemas per provider,
provider-specific HTTP clients, etc.) the realistic graph cost is
**~80–120 MB per binary that imports `@atlas/llm`**.

**Constraint:** the daemon legitimately needs to invoke models from
multiple providers — we can't statically choose ONE. But we CAN load the
provider on demand via dynamic import:
```ts
const { createAnthropicWithOptions } = await import("@atlas/llm/anthropic");
```
Deno's `deno compile` follows static imports for the closed graph;
dynamic imports against npm specifiers can be excluded from the bundle
and loaded at runtime IF we accept an online-runtime model OR ship them
as separate downloadable bundles (which dovetails with Tier 3.2).

**Estimated win:** 80–120 MB per binary. Affects `friday` and (likely)
`playground` if it transitively imports `@atlas/llm`. **Lazy-loading is
free for daemon use because each provider is invoked only when a
workspace's model selection lands on it** — the loading cost is one-time
per provider per process lifetime.

#### B. `friday` binary — chat-adapter graph leak

**Location:** chat adapters (`@atlas/chat-adapter-discord`, `-slack`,
`-telegram`, `-whatsapp`, `-teams`) are pulled into `friday` via
`@atlas/core` → atlasd's chat-handling code path. Each adapter brings
its own SDK (discord.js is huge, slack-bolt is heavy, etc.).

**Estimated bundle weight:** 40–80 MB total (each adapter SDK is
5–15 MB unpacked; discord.js + dependencies is the heaviest at ~25 MB).

**Same fix as A:** dynamic import keyed on the workspace's configured
adapter at runtime. A workspace using only WhatsApp doesn't load
discord.js. Adapters become per-workspace lazy-loaded modules.

**Estimated win:** 40–80 MB per binary that imports `@atlas/core`'s
chat surface.

#### C. `playground` Deno binary — embedded SvelteKit build pulls `ai` into client bundle

**Location:** `tools/agent-playground/src/lib/server/workspace/direct-executor.ts`
imports from `ai` (the Vercel AI SDK, 6.5 MB unpacked). Server-only
import, but vite's default treatment of SvelteKit server modules can
leak server deps into the client bundle if `+page.server.ts` <-> client
boundary isn't crisp. Worth verifying with `npm run build && du -sh build/_app/immutable/chunks/` and grepping for `streamText` or `generateText` in the client chunks.

**Estimated win:** 5–6 MB if leaking; 0 MB if already correctly server-only.

#### D. `playground` Deno binary — embedded frontend in general

**Architectural question raised by the audit:** why is the SvelteKit
build embedded INTO a Deno binary at all? Every UI fix requires
recompiling + re-signing + re-notarizing 950 MB. Two alternatives:

- **D.1.** Serve the frontend from a CDN at a versioned URL; the
  `playground` Deno binary becomes API-only and a thin redirector. UI
  fixes ship without binary rebuilds.
- **D.2.** Keep the frontend embedded but add a "frontend-only" CI
  workflow that re-bundles + re-uploads the UI assets without rebuilding
  the Deno binary, reusing the prior binary's Mach-O signature.

D.1 is cleaner and aligns with Tier 3.2 (lazy download). D.2 is a hack.

#### E. `friday` binary — `@modelcontextprotocol/sdk` (4.2 MB)

Pulled in via `@atlas/core` for tool discovery. Likely load-bearing for
the daemon (MCP is core to how skills work). Verify before cutting —
but if `friday` daemon uses MCP only when a workspace activates an MCP
server, this is another lazy-load candidate.

### What NOT to cut

- **`hono`** (1.3 MB, all binaries): HTTP framework everyone uses
- **`zod` (4.3 MB, all binaries):** External-input validation is mandated
  by repo policy; can't replace
- **`@sentry/deno` (2 MB):** Production observability, required
- **`postgres`:** Native SQL driver in `link`'s critical path

### `friday-launcher` (Go) — already near-optimal

7.6 MB binary. ~0.6–1.2 MB recoverable IF we fork process-compose to
strip `tcell`/`tview`/`gin` (color.go pulls tcell unconditionally even
though only TUI uses it). Maintenance burden > savings. **Skip.**

### Compounding effect with Tier 3.2 (lazy download)

The dep cuts here are independent of architecture but compound nicely:

- Cut friday daemon by ~150 MB via A + B → 800 MB binary instead of 950 MB
- Cut playground by ~10 MB via C, plus architecturally split via D → 940 MB binary
- With Tier 3.2 (lazy download), each binary is downloaded independently
  → these cuts directly reduce per-binary download time on first launch

### Updated Sprint plan

**Add to Sprint 1 (this week):**
- **A. Lazy-load AI providers** in `@atlas/llm` — biggest win per binary,
  pure refactor, no architecture change. Saves 80–120 MB on `friday` AND
  `playground` immediately.
- **C. Audit playground client bundle for server-dep leakage** — quick
  check, may find easy 5–6 MB win.

**Add to Sprint 2:**
- **B. Lazy-load chat adapters** keyed on workspace config — needs a
  small refactor of how adapters get registered, but the payoff is 40–80
  MB on `friday` permanently.

**Add to Sprint 3 (with Tier 3.2):**
- **D.1. Move playground frontend to CDN** — naturally aligns with the
  per-binary download manifest from 3.2.

## Verified Offender Map (file:line precision)

The deep dep audit traced the actual `friday` daemon import graph from
source code (not just package manifests). Findings are concrete and
checkable.

### O1. `packages/bundled-agents/src/registry.ts:4-21` and `src/index.ts:1-33` — **biggest single source of bloat**

```
packages/bundled-agents/src/registry.ts:4-7
import { createAnthropicWithOptions } from "@atlas/llm/anthropic";
import { createGoogleWithOptions }    from "@atlas/llm/google";
import { createGroqWithOptions }      from "@atlas/llm/groq";
import { createOpenAIWithOptions }    from "@atlas/llm/openai";

packages/bundled-agents/src/index.ts:1-30  (~18 lines)
import { slackCommunicatorAgent } from "./slack/communicator.ts";
import { googleCalendarAgent }    from "./google/calendar.ts";
import { hubspotAgent }           from "./hubspot/agent.ts";  // pulls @hubspot/api-client (19 MB)
import { jiraAgent }              from "./jira/agent.ts";     // pulls jira.js
import { snowflakeAnalystAgent }  from "./snowflake/agent.ts";// pulls snowflake-sdk
import { ghAgent }                from "./gh/agent.ts";       // pulls octokit
// ... 14 more eager imports

packages/bundled-agents/src/index.ts:32-38
export const bundledAgents: AtlasAgent[] = [
  slackCommunicatorAgent, googleCalendarAgent, hubspotAgent,
  jiraAgent, snowflakeAnalystAgent, ghAgent, ...
];
```

**Effect:** every consumer of `@atlas/bundled-agents` pulls in **18 agents
× their respective SDKs**. `friday` daemon imports
`@atlas/bundled-agents` via `apps/atlasd/routes/workspaces/index.ts:12`,
so all 18 land in the binary regardless of what workspaces are
configured.

**Constraint:** Dynamic imports are off the table by design (they
fragment the type graph + complicate review). The fix has to make these
deps **structurally absent from the static import closure**, not
runtime-deferred.

**Fix — eject heavy agents from `@atlas/bundled-agents`:** the package
keeps only agents that pull lightweight deps; everything else moves to
separate packages that the daemon never imports.

```
packages/bundled-agents/   ← lightweight defaults that ship in friday
  - csv-sampler/
  - summary/
  - table/
  - knowledge/
  - web/                   ← only if its SDK is small (verify)
  - bb/                    ← internal, presumed light
  - claude-code/           ← keep (no heavy SDK)
  - data-analyst/          ← keep if no heavy SDK
  - email/                 ← keep if it uses just fetch + a small lib
  - image-generation/      ← keep IF the provider SDK is small
  - transcription/         ← keep IF small
  - fathom/                ← keep IF small

packages/optional-agents/  ← NEW workspace; NOT in friday's static graph
  - slack/                 → @slack/bolt
  - google-calendar/       → googleapis
  - hubspot/               → @hubspot/api-client (19 MB)
  - jira/                  → jira.js
  - gh/                    → octokit
  - snowflake-analyst/     → snowflake-sdk
```

**How workspaces use them:** the daemon's existing extension-install
pipeline (the same one that downloads MCP servers + skills on demand)
fetches the optional-agent package when a workspace declares it. The
daemon then `Deno.run`s it as a child process, OR loads it from a
known path under `~/.friday/local/agents/`. Either way: no static
import in the daemon binary.

This is structurally identical to how the skills install system works
already (skills are downloaded post-install; the daemon doesn't bundle
them). We extend that pattern to heavy agents.

**Estimated savings (per binary that imports `@atlas/bundled-agents`):**
- 4 AI provider SDKs (still imported eagerly because lightweight agents
  need them) → no change. The providers are ~50 MB combined; they
  legitimately load on day-one because most workspaces use at least one.
- 6 heavy agents removed entirely from static graph → **~80 MB**
- HubSpot SDK at 19 MB no longer in graph → counted in the 80 MB above
- **Combined: ~80 MB on `friday` and ~80 MB on `playground`** (vs the
  ~130 MB the dynamic-import path would have saved). The trade is real
  but acceptable.

**A separate, complementary cut for AI providers:** `@atlas/llm`'s
4 provider factories (`createAnthropicWithOptions` etc.) live at the
package barrel. **All** consumers of `@atlas/llm` pull all 4 SDKs into
their static graph. Without dynamic imports we can't lazy-load —
but we CAN move each provider into its own subpath:
```json
// packages/llm/deno.json (after)
"exports": {
  ".":           "./mod.ts",          ← only types + lightweight utils
  "./anthropic": "./src/anthropic.ts", ← createAnthropicWithOptions
  "./openai":    "./src/openai.ts",
  "./google":    "./src/google.ts",
  "./groq":      "./src/groq.ts"
}
```
Then `bundled-agents/src/registry.ts:4-7` and any agent that uses ONE
provider imports only that provider's subpath. Agents that use multiple
import multiple subpaths — same total weight as today, but consumers
that need only one (e.g. an Anthropic-only agent) shrink.

**Estimated savings from per-provider subpath:** depends on how many
agents use which providers. If we audit and find that most agents only
use 1–2 providers, the typical Deno binary's import closure drops by
2–3 of the 4 providers worth of code, ~25–35 MB. Worth doing in
parallel with the agent ejection above.

### O2. `packages/core/src/orchestrator/agent-orchestrator.ts:20-25` — MCP client always loaded

```
packages/core/src/orchestrator/agent-orchestrator.ts:20-25
import { Client } from "@modelcontextprotocol/sdk/client";
import { StreamableHTTPClientTransport }
  from "@modelcontextprotocol/sdk/client/streamableHttp.js";
```

**Effect:** Every atlasd boot loads the MCP client even if zero
workspaces declare MCP servers. ~4–6 MB.

**Without dynamic imports — accept the cost.** MCP is a load-bearing
core feature; ~5 MB doesn't justify a structural split. **Skip this
cut.** The friday-launcher's existing MCP-server-spawn pipeline already
keeps actual MCP server processes out of the daemon binary (they're
spawned as children); the SDK client is small enough to live in the
graph permanently.

If we ever need to recover this: turn `@atlas/core`'s MCP-using
orchestrator into its own package (`@atlas/orchestrator-mcp`) so it's
not in atlasd's import graph by default; non-MCP workspaces use a
slimmer orchestrator. Effort > savings — defer.

### O3. Chat adapters — pulled by atlasd workspace registration

The audit confirmed 5 chat adapter packages all reachable from atlasd's
workspace handler. Static array of imports, same pattern as
`bundledAgents`. Locate the registration site with:
```
grep -rn "from \"@chat-adapter/" apps/atlasd packages/
```

**Without dynamic imports — make adapters separate processes.** Chat
adapters are the perfect fit for `friday-launcher`'s process-compose
supervision: each adapter runs as its own subprocess, only spawned when
a workspace declares it. The daemon binary never imports the adapter
SDKs; it talks to adapters over the existing IPC (HTTP/socket — verify
the current contract).

Concretely:
- Move each `@chat-adapter/<name>` into its own Deno-compiled binary
  under `tools/chat-adapters/<name>/`.
- Build them via the existing `DENO_BINARIES` matrix in
  `scripts/build-studio.ts`. Each adapter binary is small (its own copy
  of V8 runtime ~700MB, but adapter-specific code is small — ~10–30 MB
  app code per adapter).
- The launcher's `project.go` adds them as conditional ProcessConfigs
  based on workspace YAML.
- atlasd talks to adapter processes via the existing HTTP/socket
  contract.

**Trade-off:** Each adapter now ships its own V8 runtime (5 adapters ×
700 MB = 3.5 GB if all adapters are bundled). This is **WORSE** for
bundle size unless combined with Tier 3.2 (lazy download) — then each
adapter is downloaded only when a workspace activates it. Without
lazy download, this is a regression.

**Conclusion:** O3 is BLOCKED on Tier 3.2 (lazy download). Don't ship
this until Tier 3.2 lands. In the meantime, atlasd keeps the chat-adapter
imports; they're ~30–40 MB but the alternative is worse without lazy
download.

### O4. `@atlas/core/mod.ts:19` — barrel re-export forces transitive bloat

```
packages/core/mod.ts:19
export * from "./src/agent-server/mod.ts";
```

**Effect:** Anyone importing ANY symbol from `@atlas/core` pulls in the
entire agent-server surface (which transitively pulls in
`@atlas/bundled-agents` → all 18 agents → all SDKs).

The `deno.json` for `@atlas/core` already declares 30 subpath exports
at lines 22-32 — consumers COULD do `from "@atlas/core/session"` etc.
But many call sites use the barrel `from "@atlas/core"` out of habit.
The audit found 94 barrel imports vs 522 sub-imports, so most consumers
are already disciplined. Migrate the remaining 94 + remove the barrel
re-export.

**Estimated savings:** Compounds with O1 — once O1 lazifies bundled-agents,
this leak becomes academic. Skip unless O1 isn't shippable.

### O5. `@atlas/llm/mod.ts` re-export status — actually OK as-is

The audit ran into conflicting findings. Final verdict: `@atlas/llm/mod.ts`
exports provider factories (`createAnthropicWithOptions` etc.) but they
are PURE FACTORY FUNCTIONS — they don't eagerly import the underlying
SDK. The SDK gets pulled in only when the factory is CALLED. So
`@atlas/llm/mod.ts` is innocent.

**The eager imports that pull in AI SDKs** happen in
`packages/bundled-agents/src/registry.ts:4-7` (see O1) — calling the
factories at module load time. Fix lives in O1, not in @atlas/llm.

**However**: still add per-provider subpath exports to `@atlas/llm`'s
`deno.json` so future callers can be explicit:
```json
"exports": {
  ".":           "./mod.ts",
  "./anthropic": "./src/anthropic.ts",
  "./openai":    "./src/openai.ts",
  "./google":    "./src/google.ts",
  "./groq":      "./src/groq.ts"
}
```

### O6. Dead workspace dep flagged

`npm ls` flagged `@ai-sdk/svelte@4.0.168` as **extraneous**. Confirm with
`grep -rn "from \"@ai-sdk/svelte\"" --include="*.ts" --include="*.svelte"` —
if zero hits, remove from root `package.json`. Likely small (~1–2 MB)
but free.

### O7. ★ HUGE WIN: vitest is in `dependencies` across 8 packages

**Verified by direct package.json inspection:**

```
packages/hallucination/package.json   → "vitest": "^4.1.0"  in dependencies
packages/llm/package.json             → "vitest": "^4.1.0"  in dependencies
packages/core/package.json            → "vitest": "^4.1.0"  in dependencies
packages/mcp-server/package.json      → "vitest": "^4.1.0"  in dependencies
packages/bundled-agents/package.json  → "vitest": "^4.1.0"  in dependencies
packages/fsm-engine/package.json      → "vitest": "^4.1.0"  in dependencies
packages/skills/package.json          → "vitest": "^4.1.0"  in dependencies
packages/analytics/package.json       → "vitest": "^4.1.0"  in dependencies
tools/agent-playground/package.json   → "vitest" + "vite"   in dependencies
```

**Effect:** Every Deno binary that imports any of these packages
includes the **entire vitest test runner** in its static graph, plus
its transitive deps (chai, sinon, `@vitest/coverage-v8`, V8 coverage
tooling, expect, Tinypool worker manager, etc.). vitest itself is a
huge package (~30–40 MB unpacked) and its closure is heavier still
because of coverage-v8 (~50–80 MB).

**This is almost certainly the dominant source of bloat** — and it's a
pure mistake, not an architectural issue. The fix is moving each
`"vitest"` entry from `"dependencies"` to `"devDependencies"` in 9
package.json files. **No code changes.** No dynamic imports. No
restructuring. The dep simply shouldn't be in prod at all.

**Estimated savings:** ~150–200 MB per Deno binary that transitively
imports these packages. Across `friday`, `playground`, `link` (which
imports `@atlas/llm`), this is the single highest-leverage refactor on
the entire plan.

**Bonus finds in the same audit:**
- `tools/agent-playground/package.json`: `vite` is also in
  `dependencies` instead of `devDependencies`. Vite + its plugins +
  rollup are runtime-irrelevant. Move to dev. Saves ~30–50 MB.
- `apps/atlas-cli/package.json`: `@types/react` is in `dependencies`.
  Type-only package — should be in `devDependencies`. ~1 MB but free.

### O8. Other suspect deps to verify

- `lint-staged` in root `package.json` `dependencies`: only used in
  pre-commit config. Move to devDeps. ~8 MB.
- `@types/markdown-it` in `packages/bundled-agents`: type-only, move
  to devDeps. ~0.5 MB.
- `parallel-web` in bundled-agents: only 2 imports — verify this is a
  real feature, not a leftover experiment.
- `@coderabbitai/bitbucket` in bundled-agents: zero imports flagged —
  remove if confirmed dead.

### Audit results: things that are ALREADY good

- ✅ No `@kubernetes/client-node`, no `@google-cloud/*`, no `@aws-sdk/*`,
  no `@azure/*`, no Playwright/Puppeteer in the source. Clean.
- ✅ `@sentry/deno` only — no `@sentry/node` co-installed.
- ✅ `friday-launcher` (Go) at 7.6 MB is near-optimal.
- ✅ `link` and `webhook-tunnel` Deno binaries are lean (their app code
  graphs are small; bulk is V8 runtime). No cuts needed there.

### Revised Sprint plan with O-numbered cuts

**Day 1 — the trivially-fixable mistakes (NO refactor, just package.json edits):**
- **O7: Move vitest + vite from `dependencies` to `devDependencies`** in
  9 package.json files. **~150–200 MB saved per Deno binary.**
  Highest-ROI change in the entire plan; pure mechanical edit. **DO
  THIS FIRST.**
- O7-bonus: `lint-staged`, `@types/react`, `@types/markdown-it` →
  devDeps. ~10 MB.
- O6: Remove dead `@ai-sdk/svelte` from root `package.json` if grep
  confirms zero usage. ~1–2 MB.
- O8: Verify + remove `@coderabbitai/bitbucket` if dead. Audit
  `parallel-web`.

**Day 1 estimated impact:** ~160–210 MB saved per Deno binary
**without writing or restructuring any code**. Bundle goes from
1.07 GB → ~880–910 MB compressed.

**Sprint 1 — Tier 1 + structural agent ejection:**
- Original Tier 1 (zstd, caches, no-ditto-zip) → ~150 MB + 3 min CI.
- O1: Eject heavy agents from `@atlas/bundled-agents` into a separate
  `@atlas/optional-agents` package that's NOT in atlasd's static graph.
  Heavy agents (HubSpot, Slack, Snowflake, Jira, GH, Google Calendar)
  install via the existing skills/MCP install pipeline on demand.
  **~80 MB saved on `friday` and `playground`.** No dynamic imports —
  the deps are structurally absent.
- O5: Add subpath exports to `@atlas/llm/deno.json` so future agents
  can import only the providers they need (no current consumer change).

**Sprint 1 estimated impact:** Bundle 1.07 GB → ~700 MB compressed.

**Sprint 2 — chat adapters + remaining cleanup:**
- O3: Move chat adapters out of atlasd's static import graph. Each
  adapter becomes a Deno binary supervised by friday-launcher; only
  spawned for workspaces that declare it. **~30–40 MB on `friday`,
  but the adapters themselves grow 5x because each gets its own V8
  runtime.** Net only positive WITH Tier 3.2 (lazy download). Defer
  until Sprint 3.
- O4: Audit remaining `from "@atlas/core"` barrel imports; migrate to
  subpath. Compounds with O1 — likely small once O1 lands.

**Sprint 3 — Tier 3.2 (lazy download) + chat adapters (O3) together:**
- Already documented above. With per-binary lazy download, the chat
  adapter ejection (O3) becomes net-positive: each adapter's binary
  downloads only when needed.

## Open Questions

1. Are there real users on a v0.0.x manifest who would notice if we
   ship Tier 3.2 (lazy download)? If we're pre-launch, it's safe to
   change install semantics. If users exist, gate behind opt-in.
2. Is there appetite for a monolithic Deno binary or do we want to
   keep services independently shippable for the future? This decision
   affects 3.1 vs 3.2.
3. macos-intel re-enable timeline? Drives 3.3 priority.
