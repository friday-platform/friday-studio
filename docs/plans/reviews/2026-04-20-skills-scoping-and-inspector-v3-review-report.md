# Review Report — v3

**Plan:** `docs/plans/2026-04-20-skills-scoping-and-inspector.v3.md`
**Reviewer:** /improving-plans
**Date:** 2026-04-20

Note: the invocation passed the v1 path, but v1 through v3 already exist. Reviewing v3 (the latest artifact) and producing v4 — producing v2 again would silently overwrite prior reviews' work.

## Context verification

| v3 claim | Verification |
|---|---|
| "Bundled skills via the normal API with a `createdBy: 'system'` user marker" | **Not currently supported.** Every write endpoint in `apps/atlasd/routes/skills.ts` calls `requireUser()` (80, 208, 286, 335, 426, 451, 464). No system-context bypass. Bootstrap must call `SkillStorage.publish()` directly. |
| `validateSkillReferences` for reference walks | Confirmed at `packages/skills/src/archive.ts` — already validates links against archive files. Lint can reuse for depth check. |
| No existing `skill-linter.ts` | Confirmed — net-new file. |
| `load-skill-tool.ts:73-78` builds description from hardcoded skill IDs | Confirmed. Description includes `Built-in skills: {ids.join(", ")}.` without any filter awareness. |

## Analysis of 5 new ideas

### 1. Eval CI deterministic rubric

- **Agree — v3's judge-model approach would produce flaky CI.**
- **Approach chosen for v4:** dual-mode eval harness.
  - **Authoring mode** (`--judge llm`): LLM-as-judge grades each `expected_behavior` as met/partial/missed. Useful for iterative skill development.
  - **CI mode** (`--judge rubric`, default): deterministic rubric assertions per eval case — `expected_behavior` items encoded as machine-checkable conditions (keyword presence, regex match, JSON path assertion, line count range, produced-file existence). Baseline vs skill-loaded comparison uses exact pass/fail.
- **Alternative considered:** LLM-as-judge with low-temperature + seed pinning. Rejected — provider non-determinism (cache hits, load balancing) still leaks through.
- **Alternative considered:** human review as gate. Rejected — adds weeks of latency per skill update; defeats automation.
- **Trade-off:** rubric-mode evals are less expressive than natural-language criteria. That's the point — CI needs crisp signal, not nuanced judgment.

### 2. System-publish bypass path

- **Agree — a real implementation gap.**
- **Approach chosen for v4:** `ensureSystemSkills()` calls `SkillStorage.publish("atlas", name, SYSTEM_USER_ID, input)` directly. No HTTP round-trip. HTTP routes remain auth-gated. Middleware on `POST /:namespace/:name` additionally rejects namespace `atlas` from non-system sessions (`if namespace === "atlas" && userId !== SYSTEM_USER_ID → 403`).
- **Alternative considered:** an authenticated `POST /skills/system/seed` endpoint requiring a root-token header. Rejected — extra surface area, extra secret to manage, no advantage over direct in-process calls.
- **Alternative considered:** a separate `SystemSkillStorage` class. Rejected — code duplication; `SkillStorage` already accepts arbitrary `createdBy`.

### 3. Content-hash normalization

- **Agree — cross-platform hashing without normalization is a bug magnet.**
- **Approach chosen for v4:** canonicalize before hashing:
  1. Walk the skill directory in sorted order, using relative POSIX paths.
  2. For each text file (SKILL.md, .md, .py, .sh, .json, .yaml), normalize line endings to LF and strip trailing whitespace from each line.
  3. For binary files, hash raw bytes.
  4. Compose canonical digest by concatenating `<relpath>\0<sha256>\n` per file and hashing the concatenation.
- **Helper:** `packages/skills/src/content-hash.ts` — `computeSkillHash(dir: string): Promise<string>`.
- **Alternative considered:** git-hash-object semantics (per-file hash). Rejected — git adds object headers that vary with object type; the POSIX-path/sha256 combination is simpler and self-contained.
- **Alternative considered:** zip-and-hash the archive. Rejected — archive format has timestamps and compression parameters that can vary.

### 4. Linter false-positive rate measurement

- **Agree — shipping heuristic rules without calibration risks breaking existing skills.**
- **Approach chosen for v4:** Phase 4 gains a sub-phase **4.a: corpus run**. Steps:
  1. Script `scripts/lint-corpus.ts` runs the linter over every skill in `SkillStorage.list(includeAll=true)` plus the 5 `@atlas/*` drafts plus a sample of 20 top skills.sh skills.
  2. Aggregate warning/error rates per rule.
  3. If any rule produces **>20% warning rate on warning rules** or **any false errors on existing skills**, demote to `info` (surfaced in Context tab, not blocking) or remove entirely.
  4. Publish the corpus report into `docs/learnings/` for traceability.
- **Alternative considered:** ship all rules, revise based on user complaints. Rejected — breaks user workflows first; trust costs are high.
- **Alternative considered:** ship only frontmatter-schema rules (already enforced). Rejected — misses the value of body/reference/style rules.

### 5. `load_skill` description reflects `jobFilter`

- **Agree — description is stale when filter is active.**
- **Approach chosen for v4:** `createLoadSkillTool` when passed a `jobFilter` computes the intersection of hardcoded-skill IDs with the filter at tool-creation time. Description lists only the intersection. If `jobFilter` is `null`, description is unchanged.
- **Alternative considered:** keep description static, rely on runtime rejection. Rejected — wastes round-trips; filtered-out skills reach the agent's tool-selection stage.
- **Alternative considered:** re-register the tool per job step. Implied by this approach — tool factory already takes `workspaceId` which changes per session, so per-step creation is natural.

## Overlap with prior art

- v1 review covered trust tiers, distillation pathway, content-hash concept, fork endpoint, load-time lint events.
- v2 review covered eval gates (but didn't resolve CI-vs-authoring mode — which idea #1 now addresses), session-wide Context aggregator, `allowed-tools` lint, local audit, LRU cache.
- v3 review (this one) covers CI determinism, system-publish bypass, hash normalization, lint corpus measurement, filter-aware tool description. No duplication.

## Unresolved questions carried to v4

- **Rubric-mode eval grammar.** How are `expected_behavior` rubric assertions encoded? Structured JSON with `{type: "regex-match" | "keyword" | "json-path" | "line-count-range", ...}`? Or free-form strings parsed by a known set of directives? Needs concrete schema.
- **Corpus false-positive threshold tuning.** 20% is an initial guess. Revise once we have real numbers.
- **System-skill re-publish cost.** Content-hash reconciliation only republishes on mismatch, but every republish creates a new DB row (since `publish()` bumps version). Is there a cheaper in-place update for system skills? Proposal: add `SkillStorage.replaceSystemSkill(namespace, name, input)` that overwrites rather than bumps. Out of scope for v4; note as follow-up.
- **Hash stability across Deno / Node.** Different stdlib crypto modules — should produce identical sha256 for identical input, but worth a test.
- **Tool description length budget.** If a workspace has many hardcoded skills, the `load_skill` description can balloon. Currently no cap. Out of scope but note for follow-up.

## Phase impact

v4 refines phases without restructuring. Phase 4 gains sub-phase 4.a (corpus run) + structured rubric in Phase 6 evals + direct `SkillStorage.publish` call path in Phase 6 bootstrap. Total phases still 0–8.
