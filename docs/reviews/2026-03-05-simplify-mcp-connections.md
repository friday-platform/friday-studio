# Review: simplify-mcp-stuff (pass 2)

**Date:** 2026-03-05
**Branch:** simplify-mcp-stuff
**PR:** https://github.com/tempestteam/atlas/pull/2318
**Verdict:** Clean

## Summary

Re-review after fixes. Replaces ~3400 lines of MCP connection pooling with a
240-line `createMCPTools()` function. All prior findings (HTTP retry asymmetry,
CANCEL-during-preparing leak, 4 test coverage gaps) have been addressed. The
abort signal threading through agent-context → fetchAllTools → createMCPTools is
clean. Deletion ratio (-3469/+1503) is excellent. No issues remain.

## Critical

None.

## Important

None.

## Tests

Tests are solid. 25 unit tests on `createMCPTools` cover all previously
identified gaps plus the new abort signal and HTTP retry behaviors. Coverage
includes: happy path, partial failure, credential propagation with cleanup,
retry (stdio and HTTP), stdio verification, tool filtering (allow, deny, and
combined), dispose idempotency, HTTP auth (including process.env fallback),
close rejection resilience, slow-close await, tool name collision warning,
credential error with existing serverName passthrough, and abort signal cleanup.
Test-to-impl ratio is 2.8:1 (710/253) -- healthy zone.

Mock boundaries remain clean: external SDKs (`@ai-sdk/mcp`, transports),
credential resolver, retry library. No internal mocking.

Remaining trivial gaps (non-blocking):
- `signal.reason` fallback to `new Error("Aborted")` when reason is undefined
- `LinkCredentialExpiredError` passthrough when `serverName` is already set
  (same branch shape as the tested `LinkCredentialNotFoundError` case)
