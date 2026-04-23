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

Heading index into `docs/plans/2026-04-13-openclaw-parity-plan.md`. Use
`grep -n "<marker>"` to locate each section — line numbers drift, headings
don't.

| Phase | grep marker | Summary |
|-------|-------------|---------|
| Phase 1 (adapters) | `^### Phase 1 — Adapter` | MemoryAdapter, ScratchpadAdapter, SkillAdapter interfaces + backends |
| Phase 1a delivery status | `^#### Phase 1a — Delivery` | Adapter delivery subsection under Phase 1 |
| Phase 1a.5 (autopilot/kernel) | `^### Phase 1a.5 — Autopilot` | Autonomous loop, kernel architecture, supervisory workspace |
| Kernel must-lands | `^\*\*Kernel must-lands` | Watcher suppress, active session guard, config reload safety |
| Phase 2 (skill authoring) | `^### Phase 2 — Emergent` | Todoist-in-a-fresh-workspace, skill-author FSM |
| Phase 2.5 (capabilities) | `^### Phase 2.5 — Per-skill` | Platform capability extensions |
| Phase 3 (FridayHub) | `^### Phase 3 — FridayHub` | Publishing, trust model, skill marketplace |
| Phase 4 (signals) | `^### Phase 4 — Signal` | Signal graduation, standing orders, CronManager hot-reload |
| Phase 5 (reinforcement) | `^### Phase 5 — Reinforcement` | Session reflector, consolidation, eval patches |
| Phase 6 (server backends) | `^### Phase 6 — Server-grade` | Non-local infrastructure |
| Phase 7 (signal surface) | `^### Phase 7 — Broader` | User-facing signal management |
| Phase 8 (tier-6 source mod) | `^### Phase 8 — Tier-6` | Friday builds Friday, staging area, CI gates |

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
- `packages/system/workspaces/system.yml` — System workspace (kernel)
- `workspaces/fast-improvements-source/` — This workspace (resolve the runtime id at read time via `GET /api/workspaces`; never hardcode)

## Per-task-class checklists

For each task kind, the files the architect should read FIRST.

Locate each plan section via the grep markers in the navigation table above.

### kernel-* tasks (kernel must-lands)

- Jump to the `**Kernel must-lands` section in the plan for the ordered list
- Read `packages/system/workspaces/system.yml` for current kernel config
- Read `packages/workspace/src/manager.ts` for workspace lifecycle
- Read `apps/atlasd/routes/workspaces/` for daemon routes
- Read `packages/fsm-engine/` if touching FSM behavior

### phase1a-* tasks (adapter work)

- Jump to `### Phase 1 — Adapter` in the plan for interface declarations
- Read `packages/agent-sdk/src/memory-adapter.ts`, `scratchpad-adapter.ts`, `skill-adapter.ts`
- Read `packages/agent-sdk/src/schema-boundary.ts`, `messages.ts`
- Read `packages/agent-sdk/src/index.ts` for export surface

### phase2-skill-* tasks (skill authoring)

- Jump to `### Phase 2 — Emergent` in the plan for Phase 2 scope
- Read `packages/agent-sdk/src/skill-adapter.ts` for SkillAdapter interface
- Read `agents/skill-author/` and `agents/skill-publisher/` for existing agents

### phase4-signal-* tasks (signal graduation)

- Jump to `### Phase 4 — Signal` in the plan for Phase 4 scope
- Read `packages/workspace/src/config-schema.ts` for signal schemas
- Read `apps/atlasd/routes/workspaces/` for signal endpoints
- Read `workspaces/*/workspace.yml` for signal declaration patterns

### phase5-* tasks (reinforcement loop)

- Jump to `### Phase 5 — Reinforcement` in the plan for Phase 5 scope
- Read `agents/reflector/` for existing reflector agent
- Read `apps/atlasd/src/session-summarizer.ts` for what gets replaced

### phase8-tier6-* tasks (source modification)

- Jump to `### Phase 8 — Tier-6` in the plan for Phase 8 scope
- Read this workspace (`workspaces/fast-improvements-source/`) as the prototype
- Read `packages/system/workspaces/system.yml` for dispatch patterns

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

## Adapter source files

Current interface shapes live in the source — read them directly rather than
trusting any prose summary. For overall delivery status, see git log on the
adapter files and the plan's Phase 1a delivery subsection.

- `packages/agent-sdk/src/memory-adapter.ts`
- `packages/agent-sdk/src/scratchpad-adapter.ts`
- `packages/agent-sdk/src/skill-adapter.ts`
- `packages/agent-sdk/src/schema-boundary.ts`
- `packages/agent-sdk/src/messages.ts`
