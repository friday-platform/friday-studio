---
name: validating-llm-outputs
description: System validation rules for LLM action outputs. Loaded by the FSM runtime when an action's validate strategy resolves to "self". Authors don't load this directly via load_skill — the runtime composes it into the action's system prompt automatically.
user-invocable: false
---

# Validating Your Own Output

You check your own output for fabrication before emitting. Before you send a response, walk every factual claim in your draft output and confirm it traces back to a tool result, the input you were given, or a direct logical inference from one of those sources. If a claim cannot be sourced, drop it.

## OUT OF SCOPE — DO NOT ATTEMPT THESE CHECKS

You are NOT a math, calendar, or timezone engine. The following are EXPLICITLY out of scope for this self-check:

1. **Arithmetic** — do not recompute sums, counts, percentages, durations, totals, or averages. If your draft says "3 + 5 = 8" or "the total is 142", trust it.
2. **Timezone conversions** — do not re-convert between timezones, do not re-check whether a UTC time matches a local time, do not re-validate offsets.
3. **Date math** — do not recompute "days between", "next Monday", "X weeks from now", or any other date arithmetic. Do not re-validate weekday-of-date claims.
4. **Unit conversions** — do not re-check "5 miles = 8.04 km" or any other unit conversion.

These computations are part of producing the answer, not part of validating its sourcing. Re-doing them here produces false-positive fabrication flags. SKIP THEM.

## BIAS TOWARD VALID WHEN UNCERTAIN

False positives (rejecting your own correct work) are STRICTLY WORSE than false negatives (letting an unsourced claim through) in this system. When you are not confident a claim is fabricated, treat it as sourced. Reserve drops for cases where you can clearly identify the missing source.

## WHAT IS FABRICATION

1. **External data without access** — your draft claims web/API/database data but you called NO tools (category: `no-tools-called` if you called zero tools; otherwise `sourcing`).
2. **False tool attribution** — your draft claims a tool returned data that does not appear in any tool result you received (category: `sourcing`).
3. **Fabricated examples due to missing tools** — your draft admits lack of tool access then generates sample data anyway, when the task did not request synthetic data (category: `sourcing`).

## LEGITIMATE DATA OPERATIONS — NOT FABRICATION

- Reformatting: `{"firstName":"Alice","lastName":"Smith"}` → "Alice Smith"
- Field extraction: picking 5 of 20 fields from a tool result
- Summarization: condensing 500 words into 50
- Number formatting: `20000` → "20,000"
- Data transformation: CSV → JSON → text
- Requested example data: when the task explicitly asks for synthetic/mock data

## SELF-CHECK CATEGORIES

When you walk your draft, classify each problem you find as exactly one of:

- `sourcing` — claim is not in tool results, input, or a direct logical inference from them, and at least one tool was called. Drop it from your output, or replace it with a sourced version if you can.
- `no-tools-called` — you called zero tools but produced claims that would require external data. Drop those claims; if the task genuinely required external data, call failStep with a reason instead.
- `judge-uncertain` — you cannot tell from your evidence whether the claim is sourced. Use sparingly; bias toward valid when uncertain.

## FIX-UP RULE

If a claim cannot be sourced, drop it from your output. If the task genuinely required external data and you have no way to source it (no tools, missing access, ambiguous input), call `failStep` with a reason rather than emitting an unsourced answer. Do not silently substitute fabricated content.

## ACTION — RECORDING YOUR VERDICT

**Output first, then record.** The `record_validation` call is the closing punctuation on your turn — once you call it, your turn is over and any text you generate after it is discarded by the runtime.

Required ordering for `pass` and `advisory`:

1. Walk your draft and apply the FIX-UP RULE above.
2. **Emit your final output** — the full text response (or, for actions with structured output, the structured payload) that the action is supposed to produce. Do not emit a transitional sentence like "Now let me record validation and return the final output" and stop there — that prefix is not the output, and the runtime captures it as if it were. Produce the full content first.
3. **Then call `record_validation` exactly once** as the closing tool call. Do not say anything else after.

Verdicts:

- `{ verdict: "pass" }` — every factual claim in your output is sourced and you have no concerns. Use this after emitting normally. **Common case.**
- `{ verdict: "advisory", issues: [...] }` — claims are sourced but you have specific concerns to surface. Use this after emitting normally; the issues ride alongside the output for downstream review.
- `{ verdict: "blocking", issues: [...] }` — you cannot source your output and cannot fix it via the FIX-UP RULE above. **Do not emit any output**; call `record_validation` with `blocking` as your only action. The runtime treats this like `failStep` — the action errors and the FSM does not transition.

Each `issues` entry should describe one unsourced claim with at minimum a `claim` string. Optional fields: `category` (e.g. `sourcing`, `no-tools-called`, `judge-uncertain`), `reasoning` (why you flagged it), `severity`, and `citation`.

### Why ordering matters

The runtime captures your `response` from the model's last text turn before the closing tool call. If you call `record_validation` first and then try to "return the final output" afterwards, that text never makes it into the recorded response — only the prefix that came before the call does. The action's downstream consumer (the document store, the next FSM step, the chat reply) sees an incomplete output.

The correct sequence for an action that produces a markdown report:

```
[full markdown report text emitted as your response]
→ record_validation({ verdict: "pass" })
→ end of turn
```

NOT:

```
"Report saved successfully. Now let me record validation and return the final output:"
→ record_validation({ verdict: "pass" })
→ (turn ends here; the actual report never gets emitted)
```

Do not skip the call. The runtime relies on `record_validation` to mark the action's verdict on the session event stream so downstream consumers (compact result shapes, the Activity page, future crystallization signals) see what you concluded. If your output is correct and sourced — which is the common case — emit it, then record `verdict: "pass"`.
