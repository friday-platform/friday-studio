# Review: fix/slack-app-duplicate-credential-label

**Date:** 2026-03-31
**Branch:** fix/slack-app-duplicate-credential-label
**PR:** #2793
**Verdict:** Needs Work

## Summary

Three-pronged fix for slack-app credential bugs: label disambiguation (append app ID), per-workspace resolution (wired bot → unwired fallback), and MCP server env merging. The strategy is sound and well-motivated. One critical issue with the env merge direction that could cause silent credential resolution bugs, and a gap in test coverage for the new load-bearing resolution logic.

## Critical

### 1. Env merge direction is inverted — workspace silently overwrites agent values

**Location:** `packages/core/src/agent-context/index.ts:358`

The spread `{ ...agentConfig.env, ...existing.env }` gives workspace values higher precedence than agent values for same-key collisions. The comment on line 345 says "Agent servers take highest precedence" and describes "workspace base + agent overlay", but the code does the opposite.

The existing test validates a non-conflicting case (agent lacks `id`, workspace has it), so the bug doesn't surface there. But if an agent intentionally overrides an env var that workspace also defines, workspace wins silently.

**Recommendation:** Two options:
1. **Simple:** Swap to `{ ...existing.env, ...agentConfig.env }` (agent wins) and let `injectSlackAppCredentialId` handle the slack-app credential ID injection afterward — that's exactly what it was built for.
2. **Precise:** Key-level smart merge where workspace wins only when it has a resolved credential ID and agent has a provider-only ref.

Option 1 is simpler and consistent with the stated precedence model.

**Worth doing: Yes** — low cost to fix (swap spread order), high risk if left (silent credential misresolution for any future agent that overrides workspace env vars).

## Important

### 2. Dead `setup_required` reason in type union

**Location:** `packages/workspace-builder/planner/resolve-credentials.ts:23`

The `UnresolvedCredential` type still includes `{ reason: "setup_required" }`, but no code path produces it anymore after this PR. The consumer at `packages/system/agents/workspace-planner/workspace-planner.agent.ts:111` still filters for it. Dead code that will confuse the next person.

**Worth doing: Yes** — quick cleanup. Remove the variant, TypeScript will flag the dead consumer check. One-commit fix.

### 3. No unit tests for the wired→unwired resolution cascade

**Location:** `packages/core/src/mcp-registry/credential-resolver.ts:161-200`

The new `resolveSlackAppCredentials` function (wired workspace → unwired fallback → throw) is the load-bearing logic for bug fix #2, but it's never exercised in tests. `resolve-credentials.test.ts` mocks `resolveCredentialsByProvider` entirely, so the slack-app dispatch at line 144 is never reached. The three scenarios (wired hit, unwired fallback, both miss) need coverage.

**Worth doing: Yes** — this is the core behavioral change. Mock the HTTP client (not `resolveCredentialsByProvider`) and test the three branches.

### 4. `injectSlackAppCredentialId` only tested on its failure path

**Location:** `packages/core/src/agent-context/agent-context.test.ts:678`

The test's `globalThis.fetch` mock only returns workspace config JSON. When `injectSlackAppCredentialId` calls `resolveSlackAppByWorkspace`, it hits the same mock, gets unparseable JSON, enters the catch block, and silently skips. The happy path (credential ID actually injected) is never exercised.

**Worth doing: Yes, but lower priority** — if finding #3 covers the resolver itself, this becomes a secondary gap. Could also be covered by integration tests. A URL-routing fetch mock would be needed.

## Tests

Tests for label disambiguation (`slack-app-dynamic.test.ts`) are well-targeted — real storage adapter, low mock ratio, directly validates the label format change. The `resolve-credentials.test.ts` refactoring from `resolveUnwiredSlackApp` mock to unified `resolveCredentialsByProvider` mock correctly mirrors the implementation shift, and the caching test validates `fetchCache` dedup still works. Main gap is the new resolver internals (findings #3 and #4 above).

## Needs Decision

1. **Duplicated regex across 3 Svelte files.** The `\s*\([A-Z0-9]+\)$` strip pattern is copy-pasted in `provider-details-column.svelte`, `sidebar-accounts.svelte`, and `+page.svelte`. Extract to a shared utility, or leave as-is given it's 3 one-liners? Author's call.

2. **`findSlackAppProviderRef` only finds the first match.** If multiple MCP servers reference slack-app credentials, only one gets the injected ID. Acceptable for current usage, but worth a comment if intentional.
