# QA Plan: Skill Scoping (assignments only)

**Context**: Simplified skill scoping — drops collections, visibility flag, and pinned versions. New model: skills with **no assignments** are global; skills **with** assignments are visible only to those workspaces. Workspace agents receive `(unassigned ∪ directly assigned)`.
**Branch**: `feat/skill-scoping-collections`
**Date**: 2026-04-07

## Prerequisites

- Daemon running on `localhost:8080` (`deno task atlas daemon status`)
- A dedicated workspace `qa-skill-scoping` (created in case 1)
- A second workspace `qa-skill-other` (created in case 1) for cross-workspace isolation checks
- Three test skills (created in cases 2–4): `@qa/skill-alpha`, `@qa/skill-bravo`, `@qa/skill-charlie`
- The workspace-chat agent does not need extra setup — it ships in `useWorkspaceSkills: true` mode
- A way to follow daemon logs (`tail -f ~/.atlas/logs/daemon.log` or whatever your local path is — confirm with the daemon team if unsure). Cases 11–13 rely on grepping the agent prompt out of these logs.

## Cases

### 1. Bootstrap test workspaces

**Trigger**:
```bash
# Workspace A — what we'll mostly test against
curl -s -X POST http://localhost:8080/api/workspaces/create \
  -H 'content-type: application/json' \
  -d '{"workspaceName":"qa-skill-scoping","ephemeral":true,"config":{"workspace":{"name":"qa-skill-scoping"}}}'

# Workspace B — for the "assigned-elsewhere" isolation cases
curl -s -X POST http://localhost:8080/api/workspaces/create \
  -H 'content-type: application/json' \
  -d '{"workspaceName":"qa-skill-other","ephemeral":true,"config":{"workspace":{"name":"qa-skill-other"}}}'
```

**Expect**: Both POSTs return `2xx` with the created workspace metadata. `GET /api/workspaces/qa-skill-scoping/skills` returns `{"skills": []}` for the empty baseline.

**If broken**: Check `apps/atlasd/routes/workspaces/index.ts` `POST /create` validation; check daemon logs for workspace-init errors.

---

### 2. Create three test skills via the catalog API

**Trigger**:
```bash
# Create blank skills, then publish content to each
for name in alpha bravo charlie; do
  SKILL_ID=$(curl -s -X POST http://localhost:8080/api/skills/ | jq -r .skillId)
  curl -s -X POST "http://localhost:8080/api/skills/qa/skill-$name" \
    -H 'content-type: application/json' \
    -d "{\"description\":\"QA skill $name\",\"instructions\":\"Use this skill for $name tasks.\",\"skillId\":\"$SKILL_ID\"}"
  echo "$name → $SKILL_ID"
done
```

**Expect**: Three publish responses with `published.skillId` populated. Save the three skillIds — later cases need them. `GET /api/skills/?namespace=qa` returns all three.

**If broken**: Auth — `POST /api/skills/` requires a logged-in user. Check `getCurrentUser()` and `~/.atlas/credentials.json`.

---

### 3. Baseline: all three skills are global, both workspaces see all three

**Trigger**:
```bash
curl -s http://localhost:8080/api/workspaces/qa-skill-scoping/skills | jq '.skills[] | "\(.namespace)/\(.name)"'
curl -s http://localhost:8080/api/workspaces/qa-skill-other/skills    | jq '.skills[] | "\(.namespace)/\(.name)"'
```

**Expect**: Both return the same three entries: `qa/skill-alpha`, `qa/skill-bravo`, `qa/skill-charlie`. (Order may differ — sort if comparing.)

**If broken**: This is the **baseline invariant** — if it fails, `listUnassigned()` SQL is wrong. Look at `packages/skills/src/local-adapter.ts` `listUnassigned` and verify the `LEFT JOIN ... WHERE sa.skill_id IS NULL` clause. Also confirm `migrateIfNeeded` didn't leave stale `skill_metadata` / `skill_assignments` rows from a previous run.

---

### 4. Assign `skill-bravo` to `qa-skill-other` only

**Trigger**:
```bash
BRAVO=<skillId from case 2>
curl -s -X POST "http://localhost:8080/api/skills/scoping/$BRAVO/assignments" \
  -H 'content-type: application/json' \
  -d '{"workspaceIds":["qa-skill-other"]}'
```

**Expect**: `{"success":true}`.

**If broken**: Route ordering — `/scoping/...` must come before `/:namespace/:name`. The previous QA report (`docs/qa/reports/2026-04-02-skill-scoping.md`) caught this exact bug. Check `apps/atlasd/routes/skills.ts` ordering.

---

### 5. After assignment: `qa-skill-scoping` no longer sees `bravo`

**Trigger**:
```bash
curl -s http://localhost:8080/api/workspaces/qa-skill-scoping/skills | jq '.skills[] | "\(.namespace)/\(.name)"'
```

**Expect**: Only `qa/skill-alpha` and `qa/skill-charlie`. `bravo` is hidden.

**If broken**: This is the **scoping invariant**. Check `resolveVisibleSkills` in `packages/skills/src/resolve.ts` — the `listUnassigned` SQL should exclude any skill that has at least one row in `skill_assignments`.

---

### 6. After assignment: `qa-skill-other` sees all three

**Trigger**:
```bash
curl -s http://localhost:8080/api/workspaces/qa-skill-other/skills | jq '.skills[] | "\(.namespace)/\(.name)"'
```

**Expect**: All three skills (alpha + charlie are still global, bravo is directly assigned to this workspace).

**If broken**: `listAssigned(workspaceId)` SQL or the union/dedup in `resolveVisibleSkills`.

---

### 7. `listAssignments` reflects state

**Trigger**:
```bash
curl -s "http://localhost:8080/api/skills/scoping/$BRAVO/assignments"
```

**Expect**: `{"workspaceIds":["qa-skill-other"]}`.

**If broken**: Local-adapter `listAssignments` SQL or route handler.

---

### 8. Multi-workspace assignment: assign `bravo` to BOTH workspaces

**Trigger**:
```bash
curl -s -X POST "http://localhost:8080/api/skills/scoping/$BRAVO/assignments" \
  -H 'content-type: application/json' \
  -d '{"workspaceIds":["qa-skill-scoping"]}'

curl -s "http://localhost:8080/api/skills/scoping/$BRAVO/assignments"
curl -s http://localhost:8080/api/workspaces/qa-skill-scoping/skills | jq '.skills | length'
curl -s http://localhost:8080/api/workspaces/qa-skill-other/skills    | jq '.skills | length'
```

**Expect**:
- `listAssignments` returns both workspace IDs.
- Both workspaces now show 3 skills.

**If broken**: `assignSkill` should be `INSERT OR IGNORE` (idempotent on the composite PK). Check `local-adapter.ts`.

---

### 9. Idempotent re-assign

**Trigger**:
```bash
curl -s -X POST "http://localhost:8080/api/skills/scoping/$BRAVO/assignments" \
  -H 'content-type: application/json' \
  -d '{"workspaceIds":["qa-skill-other"]}'
```

**Expect**: `{"success":true}` — no 409, no duplicate row, `listAssignments` still returns both IDs.

**If broken**: `assignSkill` lost its `OR IGNORE` clause.

---

### 10. Unassign one workspace, the other still sees the skill

**Trigger**:
```bash
curl -s -X DELETE "http://localhost:8080/api/skills/scoping/$BRAVO/assignments/qa-skill-other"
curl -s "http://localhost:8080/api/skills/scoping/$BRAVO/assignments"
curl -s http://localhost:8080/api/workspaces/qa-skill-scoping/skills | jq '.skills | length'  # 3
curl -s http://localhost:8080/api/workspaces/qa-skill-other/skills    | jq '.skills | length'  # 2
```

**Expect**: After unassign, `listAssignments` returns only `qa-skill-scoping`. `qa-skill-scoping` still has 3 skills (bravo is assigned to it). `qa-skill-other` drops to 2 (alpha + charlie).

**If broken**: Check `unassignSkill` SQL — should `DELETE WHERE skill_id = ? AND workspace_id = ?` only.

---

### 11. Unassign the LAST assignment → skill goes global again

**Trigger**:
```bash
curl -s -X DELETE "http://localhost:8080/api/skills/scoping/$BRAVO/assignments/qa-skill-scoping"
curl -s http://localhost:8080/api/workspaces/qa-skill-scoping/skills | jq '.skills | length'  # 3
curl -s http://localhost:8080/api/workspaces/qa-skill-other/skills    | jq '.skills | length'  # 3
```

**Expect**: With zero assignments, bravo is global again. Both workspaces see 3 skills.

**If broken**: This is the core rule — confirm `listUnassigned`'s `LEFT JOIN ... WHERE sa.skill_id IS NULL` correctly treats "no rows" as global. If a skill stays hidden after the last unassign, the SQL is filtering wrong.

---

### 12. Deleting a skill cleans its assignments (cascade)

**Trigger**:
```bash
ALPHA=<skillId from case 2>
curl -s -X POST "http://localhost:8080/api/skills/scoping/$ALPHA/assignments" \
  -H 'content-type: application/json' -d '{"workspaceIds":["qa-skill-other"]}'

curl -s -X DELETE "http://localhost:8080/api/skills/$ALPHA"
# Now hit the assignments endpoint — should be empty (skill is gone)
curl -s "http://localhost:8080/api/skills/scoping/$ALPHA/assignments"
```

**Expect**: After delete, `listAssignments` returns `{"workspaceIds":[]}`. No FK errors. The skill is gone from both workspaces.

**If broken**: `deleteSkill` in `local-adapter.ts` must `DELETE FROM skill_assignments WHERE skill_id = ?` before deleting from `skills`.

---

### 13. End-to-end: workspace-chat agent receives the resolved skill set

**Setup**: Recreate `alpha` (it was deleted in case 12) and reset everything to a clean state:
```bash
# Re-create alpha
ALPHA=$(curl -s -X POST http://localhost:8080/api/skills/ | jq -r .skillId)
curl -s -X POST "http://localhost:8080/api/skills/qa/skill-alpha" \
  -H 'content-type: application/json' \
  -d "{\"description\":\"QA skill alpha\",\"instructions\":\"...\",\"skillId\":\"$ALPHA\"}"

# Assign charlie to qa-skill-other only — so qa-skill-scoping should NOT see it
CHARLIE=<from case 2>
curl -s -X POST "http://localhost:8080/api/skills/scoping/$CHARLIE/assignments" \
  -H 'content-type: application/json' -d '{"workspaceIds":["qa-skill-other"]}'
```

**Trigger**: Send a chat to the workspace-chat agent on `qa-skill-scoping`. In a fresh terminal, follow the daemon logs first; in another terminal:
```bash
CHAT_ID=$(uuidgen)
curl -s -X POST "http://localhost:8080/api/workspaces/qa-skill-scoping/chat" \
  -H 'content-type: application/json' \
  -d "{\"id\":\"$CHAT_ID\",\"datetime\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"message\":{\"id\":\"m1\",\"role\":\"user\",\"parts\":[{\"type\":\"text\",\"text\":\"hi\"}]}}"
```

**Expect**:
- Daemon logs (or the streamed response) include the system prompt for the workspace-chat agent.
- The `<available_skills>` block contains `@qa/skill-alpha` and `@qa/skill-bravo`.
- The block does **NOT** contain `@qa/skill-charlie`.

**If broken**:
- If charlie shows up: `listUnassigned` is returning skills that have rows in `skill_assignments` — check the SQL `LEFT JOIN`.
- If alpha/bravo are missing: `listUnassigned` SQL filters too aggressively, or `resolveVisibleSkills` swallowed an error silently — check daemon log warnings for `Failed to list unassigned skills`.
- If `<available_skills>` block is missing entirely: workspace-chat agent isn't getting the resolved set wired into its prompt — check `packages/system/agents/workspace-chat/workspace-chat.agent.ts` for how it formats `availableSkills`.

---

### 14. End-to-end: assigning charlie to `qa-skill-scoping` makes it appear in the next chat

**Trigger**:
```bash
curl -s -X POST "http://localhost:8080/api/skills/scoping/$CHARLIE/assignments" \
  -H 'content-type: application/json' -d '{"workspaceIds":["qa-skill-scoping"]}'

# New chat — must be a fresh one, the prompt is built per session
CHAT_ID=$(uuidgen)
curl -s -X POST "http://localhost:8080/api/workspaces/qa-skill-scoping/chat" \
  -H 'content-type: application/json' \
  -d "{\"id\":\"$CHAT_ID\",\"datetime\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"message\":{\"id\":\"m1\",\"role\":\"user\",\"parts\":[{\"type\":\"text\",\"text\":\"hi\"}]}}"
```

**Expect**: The new agent session's `<available_skills>` block now contains all three skills (`alpha`, `bravo`, `charlie`).

**If broken**: Either the assignment wasn't picked up (workspace runtime caching the resolved set?) or `listAssigned(workspaceId)` is wrong. Check daemon logs for the resolved skill list at session start.

---

### 15. Cleanup

**Trigger**:
```bash
# Delete test skills
for sid in $ALPHA $BRAVO $CHARLIE; do
  curl -s -X DELETE "http://localhost:8080/api/skills/$sid"
done
# Workspaces are ephemeral — they can be left or removed via the workspace API
```

**Expect**: All test skills gone, no orphaned `skill_assignments` rows.

**If broken**: Ignore — cleanup is best-effort.

---

## Smoke Candidates

These are the durable invariants worth promoting to `docs/qa/smoke-matrix.md`:

- **Case 3** — Baseline: unassigned skills are global to all workspaces
- **Case 5** — After assignment, the skill disappears from non-assigned workspaces
- **Case 11** — Unassigning the last workspace makes the skill global again (the lifecycle round-trip)
- **Case 13** — Workspace-chat receives the correctly filtered `<available_skills>` (the only end-to-end check that proves the resolution actually flows into the agent prompt)

## Notes

- Cases 1–12 are pure HTTP — should run in well under a minute.
- Cases 13–14 need to actually invoke a model call. If you don't want to burn LLM credits, you can verify by interrupting the request right after the prompt is logged and grepping the daemon log for `<available_skills>`. The point is the prompt content, not the model output.
- The legacy table cleanup migration (`DROP TABLE IF EXISTS skill_metadata`, etc.) runs on daemon startup. If you have a stale local DB from before the simplification, the daemon should silently clean it up — verify by checking that startup logs contain no migration errors.
