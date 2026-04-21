# Launch Readiness — 2026-04-21

**Source:** Team call (Ken + LCF + Jenna + David, afternoon of 2026-04-21)
**Goal:** First public release of Friday. Blockers are the three bodies of
work below; everything else in `docs/plans/2026-04-17-meeting-backlog.md`
continues in parallel.

Priority tags: **P0** blocker, **P1** near-term, **P2** follow-up.

---

## Strategic Decision: Keep the Core Closed, Open-Source the Distribution

The plan shifted. We are **not** open-sourcing the orchestration core.
Customer signal (Jenna's read) is that nobody who's actually paying has
asked for it. Virality is real but so is the clean-room risk — with
modern AI, anyone can ask Claude to rewrite our repo in Next.js/Rust and
re-release it, 100% legal. That removes optionality (acquisition,
investment, growth) with no upside from us.

**What stays closed:**
- `apps/atlasd` — workspace orchestration, jobs logic, FSM execution.
- Anything with the orchestration secret sauce.

**What we open source:**
- The **standard distribution** — `atlas.yml`, system workspace,
  workspace-chat agent, default set of tools / skills / jobs, docs,
  example workspaces.
- Everything in `packages/` that is distribution config (original design
  intent before packages became a de-facto source dump).

The `packages/` vs `apps/` split needs an honest audit — some code in
`packages/` today is orchestration that leaked there over time.

Analogy: Linux distros. The kernel is the kernel; Ubuntu, Fedora, Alpine
are configurations on top. We ship our own standard distribution of
Friday — hefty because it includes defaults users actually download —
and users can fork it into their own distribution (explicitly a use case
we want to support; AI consultants rolling out Friday installations for
their clients is on the roadmap).

**Forward pointer:** `.claude/` isn't a great mental model here.
WordPress's `wp-content` is closer — themes/plugins/uploads all live in a
user-owned directory alongside a binary that just runs.

---

## Body of Work 1: Binary Distribution (P0) — DRI: LCF

**Decision window:** next 24-48h. If we commit, LCF expects through
Thursday to land the rewrite path.

### The landmine

`deno compile` is not a compiler. It bundles transpiled JS into a
stripped Deno runtime — anyone can unpack the executable and extract
every source file. `bun build --compile` is the same. Node SEAs are the
same. **No JavaScript toolchain ships a real binary today.** TypeScript
source-to-native isn't a solved problem in 2026.

Plaintext always stays plaintext either way — prompts will leak symbols
through a binary no matter how we ship it. That's why body of work 3
(codebase trim) matters regardless.

### Options under investigation

1. **Rewrite the daemon in Go** (leading option). Keep `packages/` in TS
   (open source, distribution-facing). Rewrite `apps/atlasd` in Go. We
   already use Go for operator/auth, and goroutines fit the orchestration
   pattern better than the current executor anyway. Jobs logic
   occasionally stalls under load today; a Go rewrite with NATS (or
   similar) as the event bus fixes that side-effect for free.
2. **Wasm for critical modules.** Still pseudo-code-visible in function
   shape, but structurally hard to reconstruct. Partial protection.
3. **V8 bytecode compilation.** Speculative; no viable shipping path
   today.

### Constraints

- Everything in `packages/` must stay importable by Go. Dependency
  direction has to be clean: `packages/` defines types/schemas/configs;
  the Go daemon consumes them via a stable interface (probably zod-equiv
  validators and HTTP contracts).
- The reverse direction (daemon pulling orchestration types from
  `packages/`) is the leak today that makes a clean split hard.
- The TypeScript compiler is written in Go now, which *conceptually*
  enables TS→Go tooling, but the Deno team already laid that off. Not a
  near-term option.

### What "done" looks like

- Executable that ships as a single binary + a data dir for the standard
  distribution.
- `packages/` source is visible and editable; `apps/atlasd` is opaque.
- Install flow: download executable, run in CWD, `.atlas/` materializes
  alongside (blocked on B.1 from the 2026-04-17 backlog).

---

## Body of Work 2: Import/Export Bundles + Launch Flow (P0)

Goal user journey: visitor hits the marketing site, picks a use case,
downloads the executable with the bundle baked in, runs it, feels value
in one shot.

### 2.1 Bundle shape — partially landed

Tracking doc: `docs/plans/2026-04-21-full-instance-export-plan.md`.

Already shipped on `declaw` (PR #2899 + #2974 + phases 1-3 of the
full-instance plan):
- `@atlas/bundle` package — Hasher, Lockfile, content-addressed packaging.
- Daemon routes: `GET /bundle`, `GET /bundle-all`, `POST /import-bundle`,
  `POST /import-bundle-all`.
- Global skills + memory state opt-in in phase 2 + 3.

Still to ship:
- **Manifest versioning.** Probably a `friday.lock` (or the existing
  `atlas.yml` gains a version field). Users running a bundle from declaw
  on a stale main should fail fast with a clear error, not
  silently-misbehave. MVP: version + runtime range, no migration logic.
- **Import from git URL.** Any public git URL supports `<repo>.zip` as a
  download; FAST can just fetch that. No custom packaging required. Also
  accept local zip upload.
- **Wizard UI** — checkbox what to include (workspaces, skills, memory,
  env template without secrets), get a single file. Stateless export
  first; stateful deferred.

### 2.2 `.atlas/` → CWD (P0 prerequisite)

This was B.1 in the 2026-04-17 backlog and is still not started. Without
it, multiple Friday instances on one machine collide on `~/.atlas/`,
which is unacceptable once users start downloading use-case bundles.
`getAtlasHome()` in `packages/utils/src/paths.ts` needs to default to
CWD-rooted `.atlas/` like `.git/` and `.claude/` already do.

Migration for existing users: prompt on first launch — copy or adopt
in-place. Not silent.

### 2.3 Marketing site + use-case directory — DRI: David

20 use cases by launch. Each page:
- A short (20-30s) **outcome** video — "this is what happened," not a
  walkthrough of how to use FAST. Modern attention spans don't support
  walkthroughs on a marketing surface.
- A "Deploy on Friday" badge (Railway-style) that the hosting repo can
  embed. Clicking it is the shortest possible distance between
  "interested" and "running."
- Git URL + uploaded-zip import paths.

Hero: cycle the strongest 3-5 use case videos on the landing page.

References: n8n (workflow directory), Railway (deploy templates),
opencloud.directory.dev.

Mid-term (post-launch): "Deploy on Friday" badge on any user repo opens
a Friday-hosted install page with download instructions, similar to
Railway's `/template/<id>` flow.

### 2.4 Stable internet URL for webhooks — DRI: LCF

Export flow creates webhooks. Webhooks die the moment the local dev
tunnel restarts (we use a free tunnel service today). That's fine for
"try it once" but breaks "run it for a week."

New Settings section: **Stable Internet URL**. Providers:
- Tailscale Funnel.
- Cloudflare Tunnel.
- User-supplied URL (they run their own tunnel, we just record it).

FAST records which provider is active and resolves the outward-facing
URL for every signal. Not a blocker for the "try it once" flow but
required for the "run it for a week" flow.

Sibling feature: **Routes page** in Settings that lists every registered
webhook per workspace. Closes a real discoverability gap — users can't
currently see what addresses FAST has generated for them.

---

## Body of Work 3: Codebase Trim (P1) — DRI: TBD

**Why:** smaller binary, less plaintext leakage (prompts survive compile
— trim the extraneous ones), faster ship velocity from less duplication.

**Targets:**
- Old `conversation` agent — remove if we're shipping workspace-chat
  only.
- HelloFriday.ai code — kill if unused.
- Duplicate / extraneous prompts across the tree.
- `packages/` vs `apps/` audit — every symbol: is this config, or is this
  orchestration? Decide, move, delete.

Blocks the open-source split — can't ship `packages/` publicly with
orchestration leaks inside it.

---

## Secondary Scope — Ship Alongside

### S.1 Tools transparency (extends 2026-04-17 D.1) — DRI: LCF + Ken

Skills already shipped the full transparency stack:
- Upload or import from skills.sh (official + community lanes).
- Version history with diff + restore.
- Lint viewer with auto-fix.
- Workspace-level / job-level scoping (assigned / global / available).
- Pinned badge distinguishing imported vs local.
- Install-from-skills.sh also available on the per-job page.

Bring tools to the same surface. Same add/remove/list UI, same scoping
layers, same badge system. Default tools ship with the distribution;
users add more without touching code.

No official tool registry today. `modelcontextprotocol.io` appears to
maintain one — evaluate wiring it the same way skills.sh is wired.

LCF + Ken to align on exact UI in a separate discussion this week.

### S.2 Ephemeral job configuration (P1) — design: David, exec: Eric

Today: attaching a skill/tool to a job mutates permanent config.

Ask: "run this job once with this extra skill, see if it works" — no
config mutation. Applies equally to skills and tools.

Shape: job inspector surfaces an "ephemeral" run mode where skill/tool
overrides apply to this single execution only. Results of the run inform
whether the user commits the override to permanent config.

### S.3 Model settings polish (P1) — DRI: LCF

Shipped: primary + fallback model selection, live-fetched from Vercel
Gateway (`bf0d228601` + `4fdec9e36f`).

Gaps:
- **Section order is upside down.** `conversational` and `planner` are
  the user-visible picks; put them at the top. `labels` / `classifier`
  below — those are optimizations.
- **Labels too terse.** Each section needs a one-line "what this agent
  does + what kind of model suits it." Many users won't know what
  "classifier" means without context.
- **No warning on hot-path slow models.** Picking Opus for the planner
  makes every plan take minutes. Surface a warning; don't just accept
  silently.
- **Fallback is recorded but not threaded through the runtime.** The
  configuration UI works; the downstream consumption doesn't.
- **Simple/Advanced toggle.** One-model-for-everything should be the top
  option for users who don't want per-role configuration.
- **Upcoming classes:** `image`/`video` and `coding` are the two obvious
  next additions. Deferred past launch.

### S.4 Reflection / self-mod as a first-class idiom (P1)

Technically working internally; not idiomatic for users yet. Make it
first-class so "learn from this week of work" isn't per-customer
plumbing.

Requirements:
- Partially-pre-filled on-demand reflection (not just cron-driven). User
  invokes it against a set of sessions/jobs/chats and gets a proposal.
- Workspace-chat understands its own workspace-config surface and can
  propose skill/config edits that land in the improvements tab.
- Same mechanism runs cron-style for background reflection.

Touches `memory.save` wiring — LCF to port over from latest branch.

### S.5 History UX consistency (P2) — DRI: David

Skill history is a popover today. Promote to a page-shaped view that
occupies the same space as the skill itself. Apply the same paradigm to
every text-based resource — workspace.yml, prompts, configs. One
"history of this text" UX, not N special cases.

### S.6 Chat defaults to Personal (already shipped, confirmed)

The landing `/chat` behavior is correct: opens the Personal workspace
chat. Post-launch, when organizational workspaces exist, `/chat` can
route to an org water-cooler chat, but default-to-personal is the right
behavior now.

---

## Local-Model Landscape (FYI from Ken's weekend)

LlamaCPP, JAN, and the wider Hugging Face "try-this-now" ecosystem are
starting to converge with our tool/skill orchestration shape. None of
the open models are close to frontier quality today — even the best
weights only win on narrow tasks — but the **tooling** is interesting.

ComfyUI is the standout: it's the plumbing behind most of the
"restriction-bypassing" AI video/image work floating around. It uses
tools and skills very aggressively. Worth studying for UX patterns.

**Implication for us:** design tools/skills/config surfaces to accept
local models transparently (LlamaCPP-style endpoints fit the existing
provider plumbing). Not required for launch — but the work LCF already
did to make skills transparent is the template.

---

## Order for the Next 72h

1. **LCF** — decide binary distribution path (Go rewrite vs Wasm vs
   alternative). Report back within 24h. If Go: scope + timeline.
2. **LCF** — quick alignment with Ken on tools-transparency parity with
   skills. Today or tomorrow.
3. **David** — marketing site design, use-case directory pattern, 20-30s
   outcome-reel video format. Stateless bundle export wizard design.
4. **Michal** — bundle wizard UI following David's spec (curl version
   already shipped on `declaw`).
5. **LCF** — port `memory.save` to the latest branch.
6. **LCF** — stable-URL settings section + routes page.

Next up after that: the `.atlas/` → CWD move (still the outstanding P0
from 2026-04-17), codebase trim, tools transparency implementation.

---

## Open Questions

- **Binary path commitment.** Go rewrite (clean but 2-3 day cost) vs
  Wasm partial protection (cheaper but leakier) vs ship-as-bundle-
  with-known-leakage. LCF decides within 24h.
- **Codebase trim scope.** Block launch on it, or launch-then-trim?
  Leaning: trim enough to prevent sensitive prompt leakage pre-launch;
  defer deeper refactors.
- **"Deploy on Friday" landing.** Own-hosted install-instruction page
  (static HTML, download link), straight to GitHub release, or something
  in between?
- **Customer-baked distributions** (consultant use case). Ship with
  launch bundle flow, or follow-up?
- **`packages/` stability.** Once we declare it public, what's our
  deprecation policy? Affects the plugin/ecosystem story downstream.
