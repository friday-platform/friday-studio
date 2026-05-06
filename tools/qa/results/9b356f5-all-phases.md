# QA Run: 9b356f5
**Started:** 2026-05-06T23:41:56.557Z
**Result:** 8/8 phases passed

## Per-phase

| # | Phase | Result | Notes |
|---|---|---|---|
| 1.A | 1.A — narrow allowlist enforced (toolCount=1) | ✓ pass | workspace cooked_rhubarb registered; resolved toolCount for narrow action: 1 |
| 1.B | 1.B — per-job bypass grants full tool set | ✓ pass | workspace spiral_coconut registered; tool names called: (none); bypass info-log lines: 1 |
| 4.A | 4.A — read-only fetcher → step:complete.validation.strategy=skip | ✓ pass | workspace golden_waffle registered; step:complete.validation count: 1; strategy: skip; skipReason: read-only-fetcher |
| 2.B | 2.B — outputTo doc persists as artifact | ✓ pass | artifact count in JetStream: 1 |
| 2.C | 2.C — SSE job-complete carries { artifactIds, summary } | ✓ pass | artifactIds: 1; summary length: 65; shape: compact |
| 4.B | 4.B — free-form prose action → step:complete.validation.strategy=self | ✓ pass | step:complete.validation count: 1; strategies seen: self; verdicts seen: pass |
| 11 | 11 — step:complete events carry usage{inputTokens,outputTokens} | ✓ pass | inputTokens total: 55908; outputTokens total: 964; tool calls captured: 7 |
| 12 | 12 — request_tool_access emits tool-allowlist elicitation | ✓ pass | workspace blanched_quinoa registered; elicitations returned: 1; first elicitation kind: tool-allowlist |

## Detail metrics

```json
[
  {
    "phase": "1.A — narrow allowlist enforced (toolCount=1)",
    "pass": true,
    "notes": [
      "workspace cooked_rhubarb registered",
      "resolved toolCount for narrow action: 1"
    ],
    "metrics": {
      "wallTimeMs": 8574,
      "sessionId": "f09e7b11-8550-494e-b5a5-29ee2cdba55a",
      "resolvedToolCount": 1
    }
  },
  {
    "phase": "1.B — per-job bypass grants full tool set",
    "pass": true,
    "notes": [
      "workspace spiral_coconut registered",
      "tool names called: (none)",
      "bypass info-log lines: 1"
    ],
    "metrics": {
      "wallTimeMs": 11862,
      "sessionId": "5330a32d-a8f6-4da7-8c1f-d1879d5e1ece",
      "toolNamesCalled": [],
      "bypassLogCount": 1
    }
  },
  {
    "phase": "4.A — read-only fetcher → step:complete.validation.strategy=skip",
    "pass": true,
    "notes": [
      "workspace golden_waffle registered",
      "step:complete.validation count: 1",
      "strategy: skip",
      "skipReason: read-only-fetcher"
    ],
    "metrics": {
      "wallTimeMs": 1743,
      "sessionId": "26dedccf-7484-4b59-8847-4eb9e68d0250",
      "stepValidationCount": 1,
      "stepValidations": [
        {
          "strategy": "skip",
          "skipReason": "read-only-fetcher"
        }
      ]
    }
  },
  {
    "phase": "2.B — outputTo doc persists as artifact",
    "pass": true,
    "notes": [
      "artifact count in JetStream: 1"
    ],
    "metrics": {
      "artifactsInJetStream": 1
    }
  },
  {
    "phase": "2.C — SSE job-complete carries { artifactIds, summary }",
    "pass": true,
    "notes": [
      "artifactIds: 1",
      "summary length: 65",
      "shape: compact"
    ],
    "metrics": {
      "jobToolResultShape": "compact",
      "artifactIdsInPayload": 1,
      "summaryLength": 65
    }
  },
  {
    "phase": "4.B — free-form prose action → step:complete.validation.strategy=self",
    "pass": true,
    "notes": [
      "step:complete.validation count: 1",
      "strategies seen: self",
      "verdicts seen: pass"
    ],
    "metrics": {
      "stepValidationCount": 1,
      "selfStrategyCount": 1,
      "stepValidations": [
        {
          "strategy": "self",
          "verdict": "pass"
        }
      ]
    }
  },
  {
    "phase": "11 — step:complete events carry usage{inputTokens,outputTokens}",
    "pass": true,
    "notes": [
      "inputTokens total: 55908",
      "outputTokens total: 964",
      "tool calls captured: 7"
    ],
    "metrics": {
      "totalUsage": {
        "inputTokens": 55908,
        "outputTokens": 964,
        "cacheReadTokens": 0,
        "cacheWriteTokens": 0
      },
      "toolCallCount": 7
    }
  },
  {
    "phase": "12 — request_tool_access emits tool-allowlist elicitation",
    "pass": true,
    "notes": [
      "workspace blanched_quinoa registered",
      "elicitations returned: 1",
      "first elicitation kind: tool-allowlist"
    ],
    "metrics": {
      "wallTimeMs": 7578,
      "sessionId": "f9c869a7-c788-4977-a627-c4749b57c419",
      "elicitationCount": 1,
      "firstElicitationKind": "tool-allowlist",
      "firstElicitationToolName": "secret_tool"
    }
  }
]
```