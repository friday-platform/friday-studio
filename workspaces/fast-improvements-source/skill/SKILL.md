---
name: parity-plan-context
description: Navigation map and per-task-class checklists for the FAST Improvements (Source) workspace architect. References current plan and source — no embedded declarations.
---

# Parity Plan Navigation

Reference material for the claude-code architect agent. The architect
has filesystem access and reads the actual plan + source. This skill
provides navigation shortcuts and cross-file invariants, not embedded
code. Read the real files — this is a map, not a substitute.

## Plan navigation

Line-range index into `docs/plans/2026-04-13-openclaw-parity-plan.md`:

| Phase | Lines | Summary |
|-------|-------|---------|
| Phase 1a (adapters) | 582-694 | MemoryAdapter, ScratchpadAdapter, SkillAdapter interfaces + backends |
| Phase 1a.5 (autopilot/kernel) | 1115-1353 | Autonomous loop, kernel architecture, supervisory workspace |
| Kernel must-lands | 1289-1353 | Watcher suppress, active session guard, config reload safety |
| Phase 2 (skill authoring) | 1355-1391 | Todoist-in-a-fresh-workspace, skill-author FSM |
| Phase 2.5 (capabilities) | 1392-1447 | Platform capability extensions |
| Phase 3 (FridayHub) | 1449-1497 | Publishing, trust model, skill marketplace |
| Phase 4 (signals) | 1499-1512 | Signal graduation, standing orders, CronManager hot-reload |
| Phase 5 (reinforcement) | 1514-1537 | Session reflector, consolidation, eval patches |
| Phase 6 (server backends) | 1539-1558 | Non-local infrastructure |
| Phase 7 (signal surface) | 1560-1570 | User-facing signal management |
| Phase 8 (tier-6 source mod) | 1572-1621 | Friday builds Friday, staging area, CI gates |

## Source layout

- `packages/agent-sdk/src/` — SDK interfaces (MemoryAdapter, ScratchpadAdapter, SkillAdapter, schema boundary, streaming events)
- `packages/workspace/src/` — Workspace runtime, config schema, manager, watchers
- `packages/workspace/src/config-schema.ts` — Zod schemas for workspace.yml (memory mounts, improvement policy)
- `packages/fsm-engine/` — FSM engine (state machines, guards, actions)
- `packages/adapters-md/` — Markdown-backed adapter implementations
- `apps/atlasd/` — Daemon (routes, session management, workspace management)
- `apps/atlasd/routes/workspaces/` — Workspace CRUD + update + signal endpoints
- `agents/` — Python WASM agents (user-type, built via `deno task atlas agent build`)
- `workspaces/` — Workspace definitions (workspace.yml + skill/ dirs)
- `workspaces/fast-loop/` — FAST Loop kernel (thick_endive)
- `workspaces/fast-improvements-source/` — This workspace (braised_biscuit)

## Per-task-class checklists

For each task kind, the files the architect should read FIRST.

### kernel-* tasks (kernel must-lands)

- Read plan lines 1289-1353 for the kernel must-lands list
- Read `workspaces/fast-loop/workspace.yml` for current kernel config
- Read `packages/workspace/src/manager.ts` for workspace lifecycle
- Read `apps/atlasd/routes/workspaces/` for daemon routes
- Read `packages/fsm-engine/` if touching FSM behavior

### phase1a-* tasks (adapter work)

- Read plan lines 582-694 for interface declarations
- Read `packages/agent-sdk/src/memory-adapter.ts`, `scratchpad-adapter.ts`, `skill-adapter.ts`
- Read `packages/agent-sdk/src/schema-boundary.ts`, `messages.ts`
- Read `packages/agent-sdk/src/index.ts` for export surface

### phase2-skill-* tasks (skill authoring)

- Read plan lines 1355-1391 for Phase 2 scope
- Read `packages/agent-sdk/src/skill-adapter.ts` for SkillAdapter interface
- Read `agents/skill-author/` and `agents/skill-publisher/` for existing agents

### phase4-signal-* tasks (signal graduation)

- Read plan lines 1499-1512 for Phase 4 scope
- Read `packages/workspace/src/config-schema.ts` for signal schemas
- Read `apps/atlasd/routes/workspaces/` for signal endpoints
- Read `workspaces/*/workspace.yml` for signal declaration patterns

### phase5-* tasks (reinforcement loop)

- Read plan lines 1514-1537 for Phase 5 scope
- Read `agents/reflector/` for existing reflector agent
- Read `apps/atlasd/src/session-summarizer.ts` for what gets replaced

### phase8-tier6-* tasks (source modification)

- Read plan lines 1572-1621 for Phase 8 scope
- Read this workspace (`workspaces/fast-improvements-source/`) as the prototype
- Read `workspaces/fast-loop/workspace.yml` for dispatch patterns

### agent-* tasks (Python WASM agents)

- Read `agents/<id>/agent.py` + `agents/<id>/agent.json`
- Read `agents/<id>/test_*.py` for existing tests
- Run `deno task atlas agent build agents/<id>` to verify

## Cross-file invariants

If you touch X, you must also touch Y:

- `workspace.yml` structure change -> `packages/workspace/src/config-schema.ts` (Zod schema)
- `workspace.yml` `memory.mounts` change -> verify mount sources exist on target workspace
- `agent.py` change -> version bump in `agent.json` + update `test_*.py`
- `packages/agent-sdk/src/*.ts` new export -> `packages/agent-sdk/src/index.ts` re-export
- `packages/agent-sdk/src/messages.ts` new event -> wire into `AtlasDataEventSchemas` union
- `config-schema.ts` new field -> `packages/workspace/src/__tests__/config-schema.test.ts`
- Any new Zod schema -> use `z.strictObject` for required shapes (Zod v4)
- Any new file -> `deno check` + `deno lint` must pass

## Phase 1a status

Tasks 1-3 landed on the `declaw` branch (15 tests passing in
`packages/agent-sdk/src/phase1a-interfaces.test.ts`). Tasks 4-7
and Phase 1b remain. Read the actual source files for current
interface shapes — they may have evolved since the plan was written.

Source files: `packages/agent-sdk/src/memory-adapter.ts`,
`scratchpad-adapter.ts`, `skill-adapter.ts`, `schema-boundary.ts`,
`messages.ts`.
