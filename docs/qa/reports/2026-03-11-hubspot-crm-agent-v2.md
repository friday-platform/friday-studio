# QA Report: HubSpot CRM Agent (v2)

**Date**: 2026-03-11
**Mode**: run
**Source**: `docs/qa/plans/hubspot-crm-agent-cases.md`
**Branch**: `feature/hubspot-crm-agent`

## Summary

**20 of 22 cases executed. 20 PASS, 0 FAIL, 1 SKIP, 1 PASS with finding.**

| # | Case | Result |
|---|------|--------|
| 1 | HubSpot provider loads | PASS |
| 2 | OAuth credential health | PASS |
| 3 | Search contacts | PASS |
| 4 | Get object properties | PASS |
| 5 | Search owners | PASS |
| 6 | Get pipelines | PASS |
| 7 | Create a contact | PASS |
| 8 | Update a contact | PASS |
| 9 | Create and associate a note | PASS |
| 10 | Upsert creates new record | PASS |
| 11 | Upsert updates existing record | PASS |
| 12 | Get single contact by ID + associations | PASS |
| 13 | Multi-step search with filters | PASS |
| 14 | Bulk create (3 contacts) | PASS |
| 15 | Paginated search | PASS |
| 16 | List associations | PASS |
| 17 | Unlink association | PASS |
| 18 | Read-only object enforcement (quotes) | PASS |
| 19 | Batch size limit exceeded (15 items) | PASS |
| 20 | Create with missing required properties | PASS* |
| 21 | Token expiry resilience | SKIP |
| 22 | Cleanup verification | PASS |

## Findings

### Case 16 — List associations (PASS after system prompt rewrite)

Initially failed: Haiku searched all objects unfiltered instead of using
`manage_associations list` or `get_crm_object` with associations, producing
false positives. On retry with explicit tool name, Haiku hallucinated that
`manage_associations` "does not have a list action."

**Fixed by**: System prompt rewrite in `c3016e577` added a dedicated
"Associations" section with clearer guidance. After the fix, the agent used
`get_crm_object` with `associations: ["companies", "deals", "tickets", "notes",
...]` — fetching the contact with all association types expanded in a single
call. Results were correct: 1 company, 1 note, nothing else.

### PASS*: Case 20 — Create with missing required properties

The test assumed HubSpot API requires `dealname` for deals. It doesn't — HubSpot
accepted an empty deal (ID `493493772501`). The create tool handled this
correctly. Updated assumption: deals have no strictly required properties.

### SKIP: Case 21 — Token expiry resilience

Requires 30+ minutes of wait time. HubSpot tokens expire after 30 minutes;
Link's proactive refresh (5-minute window before expiry) handles this. Deferred
to manual verification.

### Batch size handling (Case 19)

Agent correctly split 15 contacts into 2 batches (10 + 5) when the max per call
is 10. The Zod schema enforces the limit, and the agent's `experimental_repairToolCall`
or natural intelligence handles the split gracefully. No records were dropped.

### Upsert idempotency (Cases 10-11)

Upsert correctly created a new contact on first call (`new: true`) and updated
the existing record on second call with the same email (`new: false`). Same
contact ID `734779854054` across both calls.

### Association operations (Cases 9, 12, 17)

- **Link** (Case 9): Note created and associated with contact via inline
  association or `manage_associations` — works.
- **Get with associations** (Case 12): `get_crm_object` returned contact with 2
  linked notes — works.
- **Unlink** (Case 17): `manage_associations` with `action: "unlink"` removed
  one note association — works.
- **List** (Case 16): Tool works when explicitly requested (Case 17 listed
  associations before unlinking), but agent doesn't discover it naturally.

## Test Data Created

| Type | ID | Details |
|------|-----|---------|
| Contact | 734938556612 | QA TestBot2 (qa-testbot2@friday-test.example.com) |
| Contact | 734779854054 | Upsert NewTest (upsert-new@friday-test.example.com) |
| Contact | 735096741111 | Alice Test2 (alice2@friday-test.example.com) |
| Contact | 735096741110 | Bob Test2 (bob2@friday-test.example.com) |
| Contact | 735096741112 | Carol Test2 (carol2@friday-test.example.com) |
| Contact | 734936770779-788 | test-batch-01 through test-batch-10 |
| Contact | 734942150875-879 | test-batch-11 through test-batch-15 |
| Note | 477814564049 | "QA test note v2" (unlinked from contact in Case 17) |
| Deal | 493493772501 | Empty deal (no properties, from Case 20) |

**Total: 21 contacts + 1 note + 1 deal created during this run.**

These should be manually deleted from HubSpot when no longer needed.

## Environment

- Daemon: running on port 8080, uptime 31m+
- Link: running on port 3100 (started separately)
- Web client: running on port 1420
- HubSpot credential: provider `hubspot`, user ID `86388566`, status `ready`
- Commit: `3ff77fdf2` (head of `feature/hubspot-crm-agent`)
