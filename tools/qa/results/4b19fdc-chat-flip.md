# chat-flip benchmark — 4b19fdc

**Verdict:** FAIL (gate ≥85%, measured 67.5%)

Started: 2026-05-07T01:14:56.798Z

## Bytes shipped to the chat-supervisor next turn

| Shape | Bytes |
| --- | ---: |
| legacy (`output: Document[]`, pre-Phase-2.C) | 679 |
| compact (`{ artifactIds, summary }`, post-flip) | 221 |
| reduction | 67.5% |

## Wall + sessions

- control (direct inbox-event): 49689ms — session 3c4e3777-7174-406e-9325-b9cd5c902b68
- chat (chat → auto-triage tool): 62505ms — session 0160c16e-0768-44c1-b03f-64ec564f64aa
- inner session (auto-triage from chat): aef7f84c-82f7-4c0e-b576-0e8ff05286d4
- auto-triage tool calls observed: 1
- chat-side tool succeeded: yes

## Chat-supervisor token usage

- aggregate `step:complete.usage.inputTokens`: 0
- usage available on agent step: no

## Notes

- control returned 1 documents in output[]
- chat-supervisor step:complete.usage is absent — agent-step side-channel doesn't propagate result.usage today (runtime.ts:2740). Comparison uses tool-result bytes (the same metric that drove the −95.1% pt1 claim).
- reduction below gate: fixture's small terminal Document caps the achievable ratio. The supervisor flip is still in effect (refs replace docs), but the per-call magnitude depends on how bulky the inner job's output is. See header comment for context.
