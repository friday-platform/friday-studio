# Review: fix/chat-stream-abort-on-send

**Date:** 2026-05-08
**Branch:** fix/chat-stream-abort-on-send
**Verdict:** Clean

## Summary

This change fixes the chat page aborting its own live response stream after a user sends a message. The implementation is surgical: it prevents `ChatImpl` from sharing the `$state` rehydration array and keeps the resume effect from tracking the rehydrated-message snapshot after the one-shot resume decision.

NATS/JetStream behavior is unchanged. The reviewed stream state for `CHAT_blended_watermelon_chat_4c1gMv9G7W` remained scoped to `chats.blended_watermelon.chat_4c1gMv9G7W.messages.>` with one subject per message ID; the observed NYC itinerary came from a fresh HITL job intake, not merged chat streams.

## Critical

None.

## Important

None.

## Tests

No test files in diff.

Validation performed:

- Browser regression: new chat send streamed the assistant reply live without requiring reload.
- `npx @sveltejs/mcp svelte-autofixer tools/agent-playground/src/lib/components/chat/user-chat.svelte` reported no issues.
- `deno task -f @atlas/agent-playground check` completed with 0 errors; existing warnings only.
- NATS inspection confirmed the target chat stream did not contain messages from another chat ID.

Worth doing: No additional test in this commit — the change is a two-line state isolation fix in a Svelte/AI-SDK integration path that is better covered by an end-to-end chat-send regression than a unit test around framework internals.

## Needs Decision

1. Consider adding a browser/E2E regression for “send message in rehydrated chat streams response without reload.” This would catch this class of Svelte state aliasing bug, but it needs a stable daemon/test chat harness rather than a brittle component mock.
