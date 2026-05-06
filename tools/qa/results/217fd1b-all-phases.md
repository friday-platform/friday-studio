# QA Run: 217fd1b
**Started:** 2026-05-06T23:37:50.276Z
**Result:** 8/8 phases passed

## Per-phase

| # | Phase | Result | Notes |
|---|---|---|---|
| 1.A | 1.A — narrow allowlist enforced (toolCount=1) | ✓ pass | workspace select_eggplant registered; resolved toolCount for narrow action: 1 |
| 1.B | 1.B — per-job bypass grants full tool set | ✓ pass | workspace raw_cherry registered; tool names called: (none); bypass info-log lines: 1 |
| 4.A | 4.A — read-only fetcher → step:complete.validation.strategy=skip | ✓ pass | workspace square_flour registered; step:complete.validation count: 1; strategy: skip; skipReason: read-only-fetcher |
| 2.B | 2.B — outputTo doc persists as artifact | ✓ pass | artifact count in JetStream: 1 |
| 2.C | 2.C — SSE job-complete carries { artifactIds, summary } | ✓ pass | artifactIds: 1; summary length: 65; shape: compact |
| 4.B | 4.B — free-form prose action → step:complete.validation.strategy=self | ✓ pass | step:complete.validation count: 1; strategies seen: self; verdicts seen: pass |
| 11 | 11 — step:complete events carry usage{inputTokens,outputTokens} | ✓ pass | inputTokens total: 54204; outputTokens total: 980; tool calls captured: 7 |
| 12 | 12 — request_tool_access emits tool-allowlist elicitation | ✓ pass | workspace whipped_pineapple registered; elicitations returned: 1; first elicitation kind: tool-allowlist |

## Detail metrics

```json
[
  {
    "phase": "1.A — narrow allowlist enforced (toolCount=1)",
    "pass": true,
    "notes": [
      "workspace select_eggplant registered",
      "resolved toolCount for narrow action: 1"
    ],
    "metrics": {
      "wallTimeMs": 6137,
      "sessionId": "6ee770c9-09bf-48c4-b800-4bef561d8ff5",
      "resolvedToolCount": 1
    }
  },
  {
    "phase": "1.B — per-job bypass grants full tool set",
    "pass": true,
    "notes": [
      "workspace raw_cherry registered",
      "tool names called: (none)",
      "bypass info-log lines: 1"
    ],
    "metrics": {
      "wallTimeMs": 10753,
      "sessionId": "f322c44a-096d-4d33-badd-412e635d6212",
      "toolNamesCalled": [],
      "bypassLogCount": 1
    }
  },
  {
    "phase": "4.A — read-only fetcher → step:complete.validation.strategy=skip",
    "pass": true,
    "notes": [
      "workspace square_flour registered",
      "step:complete.validation count: 1",
      "strategy: skip",
      "skipReason: read-only-fetcher"
    ],
    "metrics": {
      "wallTimeMs": 2040,
      "sessionId": "85b850e3-611a-4b84-8c33-0926bde65ac5",
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
      "inputTokens total: 54204",
      "outputTokens total: 980",
      "tool calls captured: 7"
    ],
    "metrics": {
      "totalUsage": {
        "inputTokens": 54204,
        "outputTokens": 980,
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
      "workspace whipped_pineapple registered",
      "elicitations returned: 1",
      "first elicitation kind: tool-allowlist"
    ],
    "metrics": {
      "wallTimeMs": 8254,
      "sessionId": "228d3c68-e220-4cfa-afbe-6423aa1ed448",
      "elicitationCount": 1,
      "firstElicitationKind": "tool-allowlist",
      "firstElicitationToolName": "secret_tool"
    }
  }
]
```