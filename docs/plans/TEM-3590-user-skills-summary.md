# TEM-3590: User Skills - Bead Summary

## Epic

**atlas-167**: TEM-3590: User Skills (P2)

## Feature Breakdown

| Bead | Linear | Title | Priority | Blocks |
|------|--------|-------|----------|--------|
| atlas-8ic | TEM-3585 | Skills Package + Local Adapter + API | P2 | TEM-3586, TEM-3587, TEM-3588 |
| atlas-518 | TEM-3586 | Skill Distiller Agent | P2 | TEM-3589 |
| atlas-935 | TEM-3587 | Agent Integration for Skills | P2 | - |
| atlas-86g | TEM-3588 | Cortex Skill Adapter | P3 | - |
| atlas-mso | TEM-3589 | Skill Draft Artifact Renderer | P3 | - |

## Dependency Graph

```
TEM-3585 (Foundation)
    ├── TEM-3586 (Skill Distiller)
    │       └── TEM-3589 (Frontend Renderer)
    ├── TEM-3587 (Agent Integration)
    └── TEM-3588 (Cortex Adapter)
```

## Task Breakdown by Feature

### TEM-3585: Skills Package + Local Adapter + API (13 tasks)

| Bead | Task | Blocked By |
|------|------|------------|
| atlas-n2f | Create packages/skills/ directory structure | - |
| atlas-71w | Implement Skill types | atlas-n2f |
| atlas-2xk | Implement Zod schemas | atlas-71w |
| atlas-ctn | Implement SkillStorageAdapter interface | atlas-2xk |
| atlas-ljs | Implement LocalSkillAdapter | atlas-ctn |
| atlas-6tk | Implement formatAvailableSkills helper | atlas-71w |
| atlas-r2a | Implement createLoadSkillTool factory | atlas-ljs |
| atlas-7qg | Create mod.ts public exports | - |
| atlas-i68 | Implement skills API routes | atlas-ljs |
| atlas-kq1 | Write unit tests for skills schemas | atlas-2xk |
| atlas-hl6 | Write unit tests for formatAvailableSkills | atlas-6tk |
| atlas-66h | Write integration tests for LocalSkillAdapter | atlas-ljs |
| atlas-ldr | Write integration tests for skills API endpoints | atlas-i68 |

### TEM-3586: Skill Distiller Agent (7 tasks)

| Bead | Task | Blocked By |
|------|------|------------|
| atlas-awv | Add skill-draft artifact type to packages/core | - |
| atlas-wws | Create skill-distiller agent directory structure | - |
| atlas-y6r | Implement skill-distiller agent input/output types | atlas-wws |
| atlas-ixh | Implement skill-distiller system prompt | atlas-wws |
| atlas-5ne | Implement skill-distiller agent handler | atlas-awv, atlas-y6r, atlas-ixh |
| atlas-o3t | Write tests for skill-distiller agent | atlas-5ne |
| atlas-js8 | Register skill-distiller agent in system agents | atlas-5ne |

### TEM-3587: Agent Integration for Skills (6 tasks)

| Bead | Task | Blocked By |
|------|------|------------|
| atlas-bks | Implement create_skill tool | - |
| atlas-hjl | Modify load_skill to check hardcoded skills first | - |
| atlas-cfk | Modify agent-context to fetch and inject skills | - |
| atlas-dpe | Write tests for create_skill tool | atlas-bks |
| atlas-5vt | Write tests for unified load_skill | atlas-hjl |
| atlas-9vh | Write tests for agent-context skill injection | atlas-cfk |

### TEM-3588: Cortex Skill Adapter (4 tasks)

| Bead | Task | Blocked By |
|------|------|------------|
| atlas-e7p | Implement CortexSkillAdapter | - |
| atlas-64m | Update createSkillStorageAdapter factory for Cortex | atlas-e7p |
| atlas-2zg | Write integration tests for CortexSkillAdapter | atlas-e7p |
| atlas-pvd | Test factory returns correct adapter based on env | atlas-64m |

### TEM-3589: Skill Draft Artifact Renderer (5 tasks)

| Bead | Task | Blocked By |
|------|------|------------|
| atlas-e2k | Implement markdown rendering for instructions | - |
| atlas-cak | Create SkillDraftViewer component | atlas-e2k |
| atlas-idc | Add skill-draft case to artifact viewer component | atlas-cak |
| atlas-4of | Style skill-draft as pending approval | atlas-cak |
| atlas-kqu | Add validation status display (optional) | atlas-cak |

## Total: 35 tasks across 5 features

## Implementation Order (Critical Path)

1. **Foundation (TEM-3585)** - Must complete first
   - Start: atlas-n2f (directory structure)
   - Critical path: n2f → 71w → 2xk → ctn → ljs → (i68, r2a, 66h)

2. **Parallel Track A: Skill Distiller (TEM-3586)** - After TEM-3585
   - Start: atlas-awv, atlas-wws (parallel)
   - Critical path: awv + (wws → y6r, ixh) → 5ne → (o3t, js8)

3. **Parallel Track B: Agent Integration (TEM-3587)** - After TEM-3585
   - Can work bks, hjl, cfk in parallel
   - Tests follow implementations

4. **Parallel Track C: Cortex Adapter (TEM-3588)** - After TEM-3585
   - Start: atlas-e7p
   - Path: e7p → 64m → pvd

5. **Frontend (TEM-3589)** - After TEM-3586
   - Start: atlas-e2k (markdown)
   - Path: e2k → cak → (idc, 4of, kqu)

## Ready Work (No Blockers)

Run `bv --robot-triage` to see current ready tasks. Initial ready tasks:
- atlas-n2f: Create packages/skills/ directory structure

## Unresolved Questions

**Q1: Cortex uniqueness constraint**
- LocalSkillAdapter uses SQLite UNIQUE(workspace_id, name)
- Does Cortex support metadata uniqueness? If not, CortexSkillAdapter needs app-level check

**Q2: Agent-context vs conversation agent load_skill** ⚠️ CRITICAL
- atlas-hjl modifies conversation agent's load_skill to be workspace-aware
- atlas-cfk adds load_skill via agent-context
- CONFLICT: Both approaches inject load_skill tool
- **RECOMMENDATION**: Pick ONE approach:
  - Option A (Simpler): Only do atlas-cfk (agent-context). Skip atlas-hjl. All agents get unified load_skill.
  - Option B (Backwards-compat): Keep both. atlas-hjl checks hardcoded first, atlas-cfk provides fallback.
- If Option B: Need to ensure conversation agent's tool doesn't get overwritten by agent-context

**Q3: Skill-distiller corpus formats**
- Design assumes artifacts contain JSON data
- What if corpus includes file artifacts (text, CSV, PDF)?
- Should skill-distiller handle readFileContents() for file artifacts?

**Q4: getCurrentUser() in skills routes**
- Design references getCurrentUser() from me/adapter.ts
- Verify this works in atlasd route context
- Alternative: Extract userId from request context/auth header

**Q5: @db/sqlite vs existing storage patterns**
- Artifact storage uses Deno KV (SQLite-backed)
- Skills use direct @db/sqlite
- Is this inconsistency intentional? Should skills use Deno KV too?

**Q6: Svelte component CSS variables**
- skill-draft.svelte uses var(--color-warning-subtle), var(--color-warning)
- Verify these CSS variables exist in web-client theme
- May need to add if missing

**Q7: LLM registry import path** ✅ VERIFIED
- atlas-5ne uses `import { registry } from "@atlas/llm"`
- Confirmed: This matches workspace-planner.agent.ts and other system agents
- Use `registry.languageModel("anthropic:claude-sonnet-4-5")` for generateObject

## Reference

- Design doc: `docs/plans/2026-01-12-user-skills-design.v5.md`
- Linear: TEM-3590 (parent), TEM-3585-3589 (children)
