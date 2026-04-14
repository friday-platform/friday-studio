# Overnight Status

**As of:** 2026-04-14 ~17:38 UTC. The autopilot loop is LIVE and ticking
on cron every 5 minutes against a real backlog. This file is a snapshot
— read `git log declaw` for authoritative state.

## Loop status

**Architecture:** the autopilot workspace `mild_almond` runs three jobs
fed by both HTTP and cron triggers:

| Signal                        | Trigger      | What it does                                                                                              |
| ----------------------------- | ------------ | --------------------------------------------------------------------------------------------------------- |
| `autopilot-tick`              | http         | Manual fire — single planner+inline-dispatch step                                                         |
| `autopilot-tick-cron`         | schedule */5 | Same job, autonomous trigger                                                                              |
| `audit-orphans`               | http         | Runs orphan-agent-auditor v1.2 → returns referenced + orphan list                                          |
| `cross-session-reflect`       | http         | step_reflect (multi-session-reflector) → step_author (skill-author) → step_publish (skill-publisher), gated on confidence ≥ 0.9 |

**Backlog:** two cheap tasks embedded inline in `prepare_plan`:
1. `reflect-grilled-xylem-recent` (priority 50) → reflect-on-last-run
2. `apply-approved-grilled-xylem` (priority 40) → apply-approved-reflection

Cooldown 1800s (30 min) per task, time-based via `/health` ISO timestamps.
Most cron ticks return `idle` (both tasks in cooldown). One task fires
roughly every 30 min.

## User agents (11 total, all v-bumped)

| Agent                       | Version | Wired into                                          |
| --------------------------- | ------- | --------------------------------------------------- |
| autopilot-planner           | 1.3.0   | mild_almond (autopilot-tick, autopilot-tick-cron)   |
| autopilot-dispatcher        | 2.0.0   | (built but unused, blocked on FSM 2nd-agent bug)    |
| orphan-agent-auditor        | 1.2.0   | mild_almond (audit-orphans)                          |
| reflector                   | 1.1.0   | grilled_xylem (reflect-on-last-run)                  |
| skill-publisher             | 1.1.0   | grilled_xylem (apply-reflection)                     |
| skill-author                | 1.0.0   | mild_almond (cross-session-reflect step_author)      |
| multi-session-reflector     | 1.0.0   | mild_almond (cross-session-reflect step_reflect)     |
| task-router                 | 1.0.0   | grilled_xylem + ripe_jam (step_route)                |
| session-summarizer          | 1.0.0   | (library agent — called by other agents)             |
| reflection-aggregator       | 1.0.0   | (library agent — called by other agents)             |
| workspace-creator           | 1.0.0   | (no consumer yet by design)                          |

Orphan-auditor v1.2: 8 referenced, 1 orphan (workspace-creator), 2 library
agents excluded.

## What works end-to-end (proven this session)

- ✅ `autopilot-tick` cron → planner → cooldown check → idle (every 5 min)
- ✅ `autopilot-tick` cron → planner → eligible task → inline POST → grilled_xylem session
- ✅ `audit-orphans` → orphan-auditor v1.2 returns 1 orphan + 2 library_orphans_excluded
- ✅ `cross-session-reflect` → multi-session-reflector → judgment confidence < 0.9 → step_author SKIPPED → step_publish SKIPPED → completed
- ✅ `apply-approved-reflection` (without explicit session_id) → walks recent sessions → finds reflect with confidence 0.85 → idles below threshold with rationale "deferred for human review"
- ✅ `reflect-on-last-run` on real failed sessions → reflector v1.1 reads session.error + block.error, returns confidence 0.95 judgment
- ✅ `task-router` routing gate in grilled_xylem AND ripe_jam — quick-fix briefs skip step_research

## Phase 1a delivery (committed in this session)

| Item                                    | Commit       | Status                                       |
| --------------------------------------- | ------------ | -------------------------------------------- |
| MemoryAdapter + corpus interfaces       | 2d7aa73f9    | landed                                       |
| ScratchpadAdapter + SkillAdapter        | 2d7aa73f9    | landed                                       |
| withSchemaBoundary helper                | 2d7aa73f9    | landed                                       |
| MdNarrativeCorpus skeleton               | a7cef9dce    | landed                                       |
| InMemoryScratchpadAdapter                | 68c3ff019    | landed (4/4 tests passing)                   |
| MdSkillAdapter                           | b9f5b57fd    | landed (5/5 tests passing)                   |
| MdMemoryAdapter facade                   | 46c3b9377    | landed (5/5 tests passing)                   |

## Still blocked on friday-starter image rebuild

Atlas-side fixes committed in source but NOT live in the running daemon:

- `f9be091fc` user-agents 404 fix (apps/atlasd/routes/agents/get.ts)
- `f6ae19635` agent tester `source: bundled\|user` discriminator
- `cc115fe84` listUserAgents honors AGENT_SOURCE_DIR
- `547403b76` code-agent-executor: don't delete __fridayCapabilities (the FSM 2nd-agent bug)
- `497e7581d` ledger ECONNREFUSED demoted to debug log
- `46c3b9377` apps/atlasd/routes/memory/get.ts (the new narrative-corpus backlog route)

friday-starter pulls a baked image from
`us-west2-docker.pkg.dev/friday-platform/releases/platform:latest`. None of
the above surface until that image is rebuilt + republished. Operator-side
handoff.

## Open question (captured separately, not yet in parity plan)

`#29` — Daemon agentContext bug: when an FSM has TWO consecutive user-agent
steps, the second invocation crashes with `Cannot read properties of
undefined (reading streamEmit/httpFetch)`. Root cause + fix in
`547403b76` (delete-on-cleanup race in code-agent-executor). Workaround
in place: planner does dispatch inline; the dedicated dispatcher v2.0.0
stays unused until the daemon image rebuilds.

## Recent autopilot tick health

Last 20 mild_almond sessions: 18 completed, 2 failed (both from a brief
window when datetime/calendar imports broke the planner before v1.2's
position-based heuristic landed). Loop is genuinely steady-state since
~17:08.

## What to ignore in `git status`

- `deno.lock` — auto-updated by deno operations
- `.DEV_FEEDBACK.md` — intentionally gitignored, persistent operator notes
- `.claude/scheduled_tasks.lock`, `.claude/skills/*/` — Claude Code harness state
- `STATUS.md` — this file
