# Chat UX & FAST — Remaining Work

**Date:** 2026-04-17
**Supersedes:** `docs/plans/2026-04-16-chat-ux-and-fast-improvements.md` (removed)
**Status:** Planning — four items carried forward from the prior plan

The prior plan's shipped items (per-workspace chat, streaming/thinking UX
fixes, task cancellation, settings + models page, Telegram/WhatsApp
adapters) landed on `declaw` between 2026-04-16 and 2026-04-17. What
remains is the Sprint-3 / decision-item tail.

---

## 3.1 Skill-based workspace creation (P1)

Root cause of the verbose workspace-creation chat noticed during the demo:
the current creation skill is rudimentary and the LLM trial-and-errors
through config shapes because the full type definitions aren't in its
context.

**Approach**
Upgrade the existing workspace-creation skill to cover every supported
config shape (agents, jobs, signals, MCP servers, FSM entry actions,
per-job overrides, credential references). Stay inside the skill — do not
fork a bespoke agent. Skills keep easily in lockstep with
`packages/config/` schemas; a custom agent goes stale as new config cases
land.

**Success looks like**
- One workspace-creation skill that fully documents every config shape
  with a worked example.
- A typical "create a workspace for X" prompt resolves in ≤ 3 tool calls
  instead of the demo's 18.
- Chat transcripts from the creation flow read as goal-directed, not
  discovery.

**Open questions**
- Does the skill embed full Zod schemas, TypeScript interfaces, or both?
  The skill system prefers prose + examples; verify the token budget
  before committing either way.
- Does workspace-creator load the skill reactively (on user intent) or
  always? Always-on is simpler but eats tokens on every turn.

---

## 3.2 Meta-skill — when to build what (P2, depends on 3.1)

Once 3.1 is in use and we have real transcripts, write the guidance that
tells an assistant whether a task should become:
- a skill (documentation + worked examples),
- an LLM-configured agent (prompt + tools),
- a Python/TS agent (deterministic execution),
- or just a one-off tool call.

**Why not now**
No data yet. Front-loading this without real usage produces fiction.
Start after 3.1 has been used for a week and there's a corpus of
"I reached for X when I should have reached for Y" notes to generalize
from.

**Trigger to start**
Ten or more workspace-creation flows through the upgraded 3.1 skill, with
at least one clear "should have been an agent" or "should have been just
a tool call" miss logged.

---

## 4.3 Per-step model routing (P2)

Unblocked by 4.2 — `friday.yml` now exposes `labels`, `classifier`,
`planner`, `conversational` archetypes, and `PlatformModels` threads them
through `AgentContext` / `WorkspaceRuntime`. Claude-Code-backed agents
currently ignore this and run Opus for every step.

**Scope**
- Identify which Claude-Code steps are over-provisioned (planning vs.
  execution vs. labeling).
- Wire those steps to read the per-archetype resolver from
  `PlatformModels` instead of the hard-coded Opus constant.
- Validate with an eval-gate comparison: Opus-only vs. routed, same
  tasks. Regression budget = 0 on the decision-heavy evals.

**Open questions**
- Does the Claude Code SDK expose a per-step model knob, or is the switch
  at the agent level only? Affects whether this is a thin wiring change
  or needs an SDK version bump.
- Who owns the routing decision — the agent's FSM author, or a default
  map derived from step kind? Default map is faster to ship; FSM-level
  override is more flexible.

---

## 4.5 Tool selection framework evaluation (P2)

**Motivation**
Transparency. We want to log tool selection decisions (why was `web_fetch`
picked over `run_code`?). Vercel's default tool router hides that
reasoning; custom routing would let us record it.

**Decision, not a commitment**
Evaluate three paths before committing:
1. Stay on Vercel's default and accept the observability gap.
2. Swap to OpenColors' routing (names a candidate library — validate it
   actually exists and solves the logging case before going further).
3. Build on Hermes (internal) — confirm scope, maintenance cost, who
   owns it.

**Deliverable**
A 1–2 page memo with: what each option gives us, what each costs, and a
recommendation. Then stop — implementation is a follow-up ticket keyed
off the memo's outcome.

---

## Execution order

1. **3.1** is the only item ready to start today.
2. **4.3** can run in parallel with 3.1 (different surface, independent).
3. **3.2** blocks on 3.1 usage data.
4. **4.5** is a memo — schedule when someone has a focused afternoon.
