# QA Report: communicator_connection prompt block

**Date**: 2026-04-30
**Branch**: worktree-hidden-fluttering-blanket
**Files changed**:
- `packages/system/agents/workspace-chat/prompt.txt` — rewrote `<communicator_connection>` block
- `packages/system/agents/workspace-chat/tools/connect-communicator.ts` — tightened tool description

## Background

A user prompt "lets check first my gmail and tell me what's the latest email over there" caused the workspace-chat agent to call `connect_communicator(kind: "slack")` — wrong tool, wrong kind. The model was reaching for any "connect" tool to authorize Gmail. The original prompt block had `## Communicators` as a markdown heading (inconsistent with surrounding XML), buried the inbound/outbound contrast in a parenthetical, and never described the runtime XML shape, the `wired` attribute, or what kinds are valid.

## Changes

1. **Prompt block rewritten** with: definition of "communicator" as inbound surface, explicit NOT-a-service contrast with redirect to `<service_connection>`, kind whitelist (`slack/telegram/discord/teams/whatsapp` — "nothing else"), 3-condition pre-call gate including `wired` branching, failsafe paragraph naming the "connect/authorize/wire" reasoning trap, and four examples covering the failure modes.

2. **Tool description tightened** at `tools/connect-communicator.ts:27` — added explicit ONLY/NOT-FOR clauses listing OAuth, credentials, Gmail, email, etc.

## Environment

- Daemon restarted at 02:36 PT (uptime 8s before tests started) to load text-imported prompt.
- Tests run against Personal workspace (`user`) — no `<communicators>` runtime injection, but `connect_communicator` tool always registered.
- Single-seed runs per case (LLM nondeterminism not controlled for; multi-seed evaluation not performed).

## Cases

### A. Gmail outbound (the screenshot bug) — PASS
**Trigger**: `lets check first my gmail and tell me what's the latest email over there`
**Tool calls**: `list_capabilities, load_skill, enable_mcp_server, delegate, run_code`
**Connect_communicator calls**: 0
**Verdict**: Service-connection path correctly taken. Exact screenshot bug is fixed.

### B. Slack inbound (positive) — PASS
**Trigger**: `can I message you on Slack?`
**Tool calls**: `connect_communicator(kind: "slack")`
**Verdict**: Correct positive case — model wired the inbound surface.

### C. Slack outbound (valid kind, wrong direction) — PASS
**Trigger**: `post an update to our #launch channel on Slack saying we're shipping today`
**Tool calls**: `list_capabilities, agent_slack`
**Connect_communicator calls**: 0
**Verdict**: Model correctly recognized outbound intent and routed to bundled Slack agent — did not reach for `connect_communicator` despite Slack being a valid kind.

### D. Ambiguous "set me up on Slack" — PASS
**Trigger**: `set me up on Slack`
**Tool calls**: 0
**Response**: Asked the user to choose between "Chat with Friday from Slack" (inbound) and "Have Friday post to Slack" (outbound).
**Verdict**: Direction-clarifying question matches the prompt's ambiguity-handling rule.

### E. Gmail wire-up variant — PASS
**Trigger**: `wire up my gmail account`
**Tool calls**: `load_skill, list_capabilities, delegate, run_code`
**Connect_communicator calls**: 0
**Verdict**: The keyword "wire up" did not trigger `connect_communicator` — service-connection path taken. Failsafe paragraph appears to be doing its job.

### F. Unsupported platform (iMessage) — PASS
**Trigger**: `hook me up on iMessage so I can text you`
**Tool calls**: 0
**Response**: Listed the five supported platforms by name and offered WhatsApp/Telegram as closest alternatives.
**Verdict**: Did not substitute a different kind. The "nothing else" enumeration in the prompt holds.

## Summary

| Case | Result | Connect_communicator? |
|------|--------|-----------------------|
| A. Gmail outbound | PASS | 0 calls (correct) |
| B. Slack inbound | PASS | 1 call, kind="slack" (correct) |
| C. Slack outbound | PASS | 0 calls (correct) |
| D. Ambiguous Slack | PASS | 0 calls (correct — asked for clarification) |
| E. Gmail wire-up | PASS | 0 calls (correct) |
| F. iMessage | PASS | 0 calls (correct) |

**6/6 pass on first run.** No escalations.

## Caveats

1. **Single-seed runs.** LLM nondeterminism means a single pass doesn't prove the prompt always behaves correctly. For higher confidence, each case should be run 3-5 times. Worth doing if any of these regress.
2. **No `<communicators>` runtime injection** in the test workspace. Condition #3 of the pre-call gate (`wired="true"` branch) was not exercised. To test the wired-true branch, would need a workspace with at least one `wired="true"` communicator configured.
3. **Pre-existing test failures** in `workspace-chat.agent.test.ts` (3 tests checking for `list_capabilities`, `mcpServers`, etc.) exist on baseline — not caused by this change.

## Recommendations

- Optional: run cases A-F 3x each on a future iteration for noise filtering.
- Optional: add a workspace fixture with `<communicators>` runtime injection to exercise the wired-true branch end-to-end.
