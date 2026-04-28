# Spec: Auto-inline skill reference files on `load_skill`

**Problem:** Skills with `references/*.md` and `assets/*.yml` files bundle them in the archive, but `load_skill` only returns the SKILL.md `instructions` text. The agent never sees reference content because (a) it has no `read_file` for arbitrary paths and (b) the `skillDir` temp path is not actionable without explicit `run_code`.

**Goal:** When `load_skill` extracts an archived skill, automatically detect and inline reference/assets content into the returned `instructions` so the agent receives a single self-contained text blob.

## Current state

`resolveGlobalSkill()` in `load-skill-tool.ts` returns:

```ts
{
  name: string;
  description: string;
  instructions: string;     // SKILL.md body only
  frontmatter?: Record<string, unknown>;
  skillDir?: string;        // /tmp/atlas-skill-... (invisible to agent)
  lintWarnings?: LintFinding[];
}
```

The agent consumes `instructions` as a text block. It has no mechanism to discover or fetch files from `skillDir`.

## Proposed change

Add a reference-inlining pass before returning. Steps:

1. **After archive extraction** (`skillDir` is set), scan `skillDir` for all files.
2. **Parse SKILL.md instructions** for local file references:
   - Markdown links: `[text](references/foo.md)` or `[text](assets/bar.yml)`
   - Backtick paths: `` `references/foo.md` `` or `` `assets/bar.yml` ``
   - Any relative path that exists under `skillDir`
3. **Read matching files** from `skillDir`.
4. **Append inlined content** to `instructions`, deduplicated (same file referenced twice = inline once).
5. **Wrap each inlined file** with a clear delimiter so the agent knows where SKILL.md ends and references begin:

```
---
## Included reference: references/job-authoring.md

<content here>
---
```

For YAML assets, wrap in a fenced code block so the agent can copy-paste.

## Boundary conditions

- **No archive** (`skillDir` undefined) → skip inlining, return as-is.
- **File not found** → log a warning, keep the original reference text in instructions (don't break the skill).
- **Circular / nested references** → only inline files directly referenced from SKILL.md. Do NOT recursively scan reference files for further references (keep it one-level, matching the existing "reference depth = 1" lint rule).
- **Size limit** → cap total inlined content at ~2000 lines or ~20KB. If exceeded, inline only files explicitly linked from the first 100 lines of SKILL.md (the agent partial-reads long skills, so front-loaded references matter most).
- **Binary files** → skip (the archive reader already detects null bytes).

## Files to touch

- `packages/skills/src/load-skill-tool.ts` — add `inlineReferences()` helper, call it in `resolveGlobalSkill()` before building the response.
- `packages/skills/tests/load-skill-tool.test.ts` — add tests for:
  - Skill with `references/*.md` → instructions include inlined content
  - Skill with `assets/*.yml` → instructions include fenced YAML block
  - Missing reference file → warning logged, instructions unchanged
  - No archive → no-op
  - Duplicate references → deduplicated

## Out of scope

- Changing the agent prompt or adding new tool shapes — the agent still calls `load_skill` and receives `instructions` text.
- Recursive reference expansion (reference links to other references) — stays at depth 1, consistent with skill authoring rules.
- `$SKILL_DIR` path rewriting — `injectSkillDir` still runs; inlined content uses real paths where needed.

## Success criteria

1. `load_skill` on `@friday/writing-workspace-jobs` returns instructions that include the contents of `assets/minimal-job-template.yml` and `assets/multi-step-job-template.yml` (referenced in the SKILL.md body).
2. An agent that loads `@friday/workspace-api` and is told to "create a job" can act on the job-authoring guidance without making a separate `run_code` call to read reference files.
3. All existing tests pass; new tests cover the 5 cases listed above.
