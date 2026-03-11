# Review: cli-refactor

**Date:** 2026-03-10
**Branch:** cli-refactor
**Verdict:** Needs Work

## Summary

Clean strangler-fig refactor that routes CLI commands between a new gunshi path
(currently just `version`) and the existing yargs path. Architecture is sound —
dynamic imports keep gunshi out of the legacy path, the three-way router is
minimal and easy to migrate incrementally. One user-facing regression (`atlas v`
alias broken) and stale docs are the main issues.

## Critical

None.

## Important

### 1. `atlas v` alias is broken — routes to "Command not found"

**Location:** `apps/atlas-cli/src/cli.ts:12` (`NATIVE_COMMANDS` set)
**Problem:** The legacy yargs `version` command registers `v` as an alias
(`apps/atlas-cli/src/commands/version.ts:11`). The new router's
`NATIVE_COMMANDS` only contains `"version"`, and `"v"` is absent from both
`NATIVE_COMMANDS` and `LEGACY_COMMANDS`. Running `atlas v` now falls through to
the unknown-command branch and prints `Command not found: v`.
**Recommendation:** Add `"v"` to `NATIVE_COMMANDS` and register it as a gunshi
subcommand pointing to `versionCommand`.
**Worth doing:** Yes — user-facing regression, existing muscle memory and scripts
may rely on it.

### 2. Plan doc and PR description are stale

**Location:** `docs/plans/2026-03-09-cli-gunshi-migration-design.md`
**Problem:** The plan references `cli/output.ts` with `out()`, `err()`,
`status()`, `chunk()` functions and JSON Result envelopes. The integration tests
section says "parse stdout as JSON." None of this exists — the JSON envelope was
dropped in commit c4e35a36. The PR description also references the JSON output
module. Future developers migrating the next command will be misled.
**Recommendation:** Update the plan doc to reflect the current plain-text output
approach, and update the PR description.
**Worth doing:** Yes — stale plan docs actively mislead future migration work.

### 3. `process.argv.slice(2)` computed twice

**Location:** `apps/atlas-cli/src/cli.ts:44,59`
**Problem:** `argv` is already computed at line 44 but line 59 calls
`process.argv.slice(2)` again instead of reusing `argv`.
**Recommendation:** Use `argv` on line 59.
**Worth doing:** Yes — trivial fix, removes redundancy.

### 4. No `--json`/`--remote` flags on native `version` command

**Location:** `apps/atlas-cli/src/cli/commands/version.ts`
**Problem:** The legacy `atlas version` supported `--json` (structured output)
and `--remote` (check for updates). The new gunshi version outputs only
`atlas v{version} ({channel})`. Any tooling parsing `atlas version --json` will
silently get wrong output (gunshi swallows unknown flags).
**Recommendation:** This appears intentional per the commit history. If so, no
action needed — but worth a callout in the PR description so reviewers are aware
of the feature reduction.
**Worth doing:** No — intentional simplification, but document the decision.

## Tests

### 5. `atlas chat` test only asserts the negative

**Location:** `apps/atlas-cli/src/cli.integration.test.ts:68-73`
**Problem:** The legacy routing test asserts `stdout` does NOT contain
"Command not found" but never confirms yargs actually handled the command. If
`cli.tsx` fails to import or crashes with an unrelated error, the test still
passes. Exit code is also unchecked.
**Recommendation:** Add a positive assertion — check for yargs-characteristic
output (e.g., `"Commands:"` or the script name) and assert on `exitCode`.
**Worth doing:** Yes — strengthens the most important routing test without
over-specifying.

### 6. `ExecErrorSchema` drops signal kills

**Location:** `apps/atlas-cli/src/cli.integration.test.ts:9-13`
**Problem:** When the 15s timeout kills a process via signal, `code` is `null`
(not `undefined`). Zod's `z.number().optional()` rejects `null`, so `safeParse`
fails entirely and the helper returns `{ stdout: "", stderr: "", exitCode: 1 }`,
swallowing diagnostic output.
**Recommendation:** Use `z.number().nullable().optional()` for `code` and add
`signal: z.string().nullable().optional()`.
**Worth doing:** No — only matters when tests hang/timeout, not a production
concern. Low priority.

### 7. Missing coverage for legacy command aliases

**Location:** `apps/atlas-cli/src/cli.integration.test.ts`
**Problem:** The router has 21 entries in `LEGACY_COMMANDS` but tests only
exercise `chat`. Short aliases (`p`, `d`, `w`, `ag`, `sig`) are the most likely
to be accidentally omitted during future migration.
**Recommendation:** Add a `test.each` for a representative sample of aliases to
confirm they don't hit the "Command not found" path.
**Worth doing:** No — the LEGACY_COMMANDS set is static and unlikely to be
accidentally modified. A single representative test is sufficient for now; full
alias coverage is over-testing.

## Needs Decision

1. **`console.log`/`console.error` in CLI entry point:** The project rule says
   "Use `@atlas/logger`, never `console.*`" with exemptions for `proto/` and
   `tools/`. The CLI entry point and version command use `console.log/error`
   directly — consistent with the legacy code but technically violating the rule.
   Either add `apps/atlas-cli/src/cli.ts` to the exemption list or switch to the
   logger. (The legacy `cli.tsx` also uses `console.log` via `displayVersion`.)
