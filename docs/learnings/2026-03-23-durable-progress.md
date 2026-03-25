# Learnings: Durable Progress Implementation (2026-03-23)

## Observed Issues

- `as` assertions in Svelte components: teammate used `as Record<string, unknown>` after `in`-operator checks where TypeScript already narrows the type. Rejected and fixed. The `in` operator on `object` narrows to `Record<"key", unknown>` — no cast needed.
- Task self-claiming caused a collision: two teammates (Leela, Ponderosa) both tried to claim Task #1 simultaneously. Ponderosa arrived second and found it already committed. Self-claiming works but needs tie-breaking when teammates start at the same time.
- Storm was spawned in `plan` mode for Task #7 (High Risk) but self-claimed Task #2 instead (which didn't need plan approval). Plan mode requirement should be communicated in the task description, not just the teammate's spawn config.
- `deno check` hook blocks bare `deno check` — must use `deno task typecheck`. Teammates hit this during verification.

## Patterns Worth Noting

- AI SDK v5 `tool()` requires `async execute` even when synchronous — `deno-lint-ignore require-await` is the correct pattern (already documented in CLAUDE.md gotchas).
- `satisfies ToolProgress` is a clean alternative to `as` for ensuring return values match an interface without widening.
- `data-*` event types that don't match `data-fsm-` or `data-session-` prefixes auto-pass the streaming-signal-trigger allowlist — no allowlist changes needed for new data events.
