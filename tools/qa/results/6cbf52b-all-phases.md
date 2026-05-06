# QA Run: 6cbf52b
**Started:** 2026-05-06T09:29:23.240Z
**Result:** 7/7 phases passed

## Per-phase

| # | Phase | Result | Notes |
|---|---|---|---|
| 1.A | 1.A — narrow allowlist enforced (toolCount=1) | ✓ pass | workspace premium_raspberry registered; resolved toolCount for narrow action: 1 |
| 1.B | 1.B — per-job bypass grants full tool set | ✓ pass | workspace velvety_icecream registered; tool names called: (none); bypass info-log lines: 1 |
| 2.B | 2.B — outputTo doc persists as artifact | ✓ pass | artifact count in JetStream: 1 |
| 2.C | 2.C — SSE job-complete carries { artifactIds, summary } | ✓ pass | artifactIds: 1; summary length: 267; shape: compact |
| 4 | 4 — validator runs on prose-emitting actions | ✓ pass | validator runs (events): 2; skip-log lines: 0 |
| 11 | 11 — step:complete events carry usage{inputTokens,outputTokens} | ✓ pass | inputTokens total: 34730; outputTokens total: 761; tool calls captured: 6 |
| 12 | 12 — request_tool_access emits tool-allowlist elicitation | ✓ pass | workspace braised_venison registered; elicitations returned: 1; first elicitation kind: tool-allowlist |

## Detail metrics

```json
[
  {
    "phase": "1.A — narrow allowlist enforced (toolCount=1)",
    "pass": true,
    "notes": [
      "workspace premium_raspberry registered",
      "resolved toolCount for narrow action: 1"
    ],
    "metrics": {
      "wallTimeMs": 7139,
      "sessionId": "f31e7661-c292-40f5-9e91-26c1deb5a30d",
      "resolvedToolCount": 1
    }
  },
  {
    "phase": "1.B — per-job bypass grants full tool set",
    "pass": true,
    "notes": [
      "workspace velvety_icecream registered",
      "tool names called: (none)",
      "bypass info-log lines: 1"
    ],
    "metrics": {
      "wallTimeMs": 15078,
      "sessionId": "9dc45d4c-6597-4563-b8ad-94222eb9077f",
      "toolNamesCalled": [],
      "bypassLogCount": 1
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
      "summary length: 267",
      "shape: compact"
    ],
    "metrics": {
      "jobToolResultShape": "compact",
      "artifactIdsInPayload": 1,
      "summaryLength": 267
    }
  },
  {
    "phase": "4 — validator runs on prose-emitting actions",
    "pass": true,
    "notes": [
      "validator runs (events): 2",
      "skip-log lines: 0"
    ],
    "metrics": {
      "validatorRunCount": 2,
      "validatorSkipCountFromLog": 0
    }
  },
  {
    "phase": "11 — step:complete events carry usage{inputTokens,outputTokens}",
    "pass": true,
    "notes": [
      "inputTokens total: 34730",
      "outputTokens total: 761",
      "tool calls captured: 6"
    ],
    "metrics": {
      "totalUsage": {
        "inputTokens": 34730,
        "outputTokens": 761,
        "cacheReadTokens": 0,
        "cacheWriteTokens": 0
      },
      "toolCallCount": 6
    }
  },
  {
    "phase": "12 — request_tool_access emits tool-allowlist elicitation",
    "pass": true,
    "notes": [
      "workspace braised_venison registered",
      "elicitations returned: 1",
      "first elicitation kind: tool-allowlist"
    ],
    "metrics": {
      "wallTimeMs": 8567,
      "sessionId": "dfdd4e05-5539-410e-8a53-bb2b02fbbc15",
      "elicitationCount": 1,
      "firstElicitationKind": "tool-allowlist",
      "firstElicitationToolName": "secret_tool"
    }
  }
]
```