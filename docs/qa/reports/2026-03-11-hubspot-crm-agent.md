# QA Report: HubSpot CRM Agent

**Date**: 2026-03-11
**Branch**: `feature/hubspot-crm-agent`
**Plan**: `docs/qa/plans/hubspot-crm-agent-cases.md`

## Summary

**13 of 14 cases executed. 12 PASS, 1 SKIP.**

| # | Case | Result |
|---|------|--------|
| 1 | HubSpot provider loads | PASS |
| 2 | OAuth authorization flow | PASS |
| 3 | Search contacts | PASS |
| 4 | Get object properties | PASS |
| 5 | Search owners | PASS |
| 6 | Get pipelines | PASS |
| 7 | Create a contact | PASS |
| 8 | Update a contact | PASS |
| 9 | Create and associate a note | PASS |
| 10 | Multi-step search with filters | PASS |
| 11 | Bulk create (3 contacts) | PASS |
| 12 | Read-only object enforcement | PASS |
| 13 | Token expiry resilience | SKIP |
| 14 | Clean up test data verification | PASS |

## Findings

### Link service not started by daemon

**Severity**: Info

`deno task atlas daemon start --detached` does not start the Link service
(port 3100). Link must be started separately or via `deno task dev` /
`deno task dev:full`. Without Link, credential resolution fails with connection
refused errors.

This is existing behavior, not a regression.

### Case 13 skipped (token expiry)

Requires 30+ minutes of wait time to test token refresh. Link's proactive
refresh (5-minute window before expiry) is the mechanism — HubSpot tokens
expire after 30 minutes. Deferring to manual verification.

## Test Data Created

The following test records were created in HubSpot during QA:

| Type | ID | Details |
|------|-----|---------|
| Contact | 734773895384 | QA TestBot (qa-testbot@friday-test.example.com) |
| Contact | 734830914766 | Alice Test (alice@friday-test.example.com) |
| Contact | 734830914765 | Bob Test (bob@friday-test.example.com) |
| Contact | 734830914767 | Carol Test (carol@friday-test.example.com) |
| Note | 477854324949 | "QA test note" associated with QA TestBot |

These should be manually deleted from HubSpot when no longer needed.

## Environment

- Daemon: running on port 8080
- Link: running on port 3100 (started separately)
- Web client: running on port 1420
- HubSpot credential: authorized under provider `hubspot`, user ID `86388566`
